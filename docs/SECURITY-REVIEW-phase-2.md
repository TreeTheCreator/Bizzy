# Phase 2 security self-review

Nov 15, 2026. Covers what Phase 2 added: AI connections (OAuth consent and the MCP endpoint), the owner's AI policy, Customers (CRM), Money (Finance), the REST API with keys, rate limits, webhooks and CSV import/export. Phase 1's review still stands: [SECURITY-REVIEW-phase-1.md](SECURITY-REVIEW-phase-1.md).

## What has and has not been verified

| Check | Status |
| --- | --- |
| Full test suite: 481 tests (190 unit, 291 against real local Supabase Postgres, Auth and Storage) | **Run, all passing** |
| Lint, type-check and production build | **Run, all passing** |
| Phase 2 acceptance: a Sales member's AI client cannot list or call Finance tools; revocation applies on the next call | **Confirmed** by `tests/db/mcp.test.ts` |
| The fresh-login rule survives a token refresh (carried over from Phase 1) | **Confirmed**, see below |
| Connecting a real AI app end to end (register, consent screen, token, tool calls over HTTP) | **Not verified in this review.** The tests drive the MCP server and the connection functions directly, with simulated AI-client tokens |
| Demo script walked in a browser | **Not done** for Phase 2 |
| GitHub Actions CI | **Not run yet** (the branch has not been pushed) |
| A real Vercel + Supabase deployment | **Not done.** Two points are open until then: Supabase's hosted OAuth Server with dynamic client registration, and whether the project accepts tokens signed with `SUPABASE_JWT_SECRET` (see DEPLOY.md) |

## Attacks tried, by area

### AI connections (MCP)

| Attack | Result | Stopped by |
| --- | --- | --- |
| Call the MCP endpoint with a normal web session token, garbage or nothing | Refused | Only tokens issued to an AI client (carrying `client_id`) for a recorded, unrevoked connection are accepted |
| List or call tools for a page the member's role lacks (Sales member, Finance tools) | Not listed; a forced call is refused and logged as a denial | Tool list is built from the member's levels; each call goes through `authorize()` and RLS again |
| Use the owner's AI connection for owner powers (roles, members, invites, policy, billing, settings) | No such tools exist; the underlying calls are refused | Every role policy excludes AI-client tokens; `authorize()` requires the web channel |
| Reach a workspace that was not ticked on the consent screen | Refused | A connection lists its workspaces; access is zero elsewhere |
| A connection widening, restoring or creating connections for itself | Refused | Connection functions refuse AI-client tokens; no update policy on connections |
| Keep working after the owner sets the AI policy to off or read only | Applies on the very next call | The policy caps the level inside the SQL access function, so nothing is cached |
| Keep working after the role is revoked, the app is disconnected, or the member is removed | Refused on the very next call, same token | Access is resolved per call in SQL |
| Delete through an AI app by accident | Needs `confirm: true`, even for the owner | Tool handlers |
| Read what was sent to the AI from the audit log | Not possible | Calls are logged with ids only |
| A non-owner changing the AI policy, or a member revoking someone else's app | Refused | Owner check; `mcp_revoke` only touches the caller's own connections |

New workspaces start with AI access **off**.

### REST API and keys

| Attack | Result | Stopped by |
| --- | --- | --- |
| Create a key without Settings manage | Refused | `api_key_create()` checks the level |
| Steal keys from the database | Only a hash is stored; the hash column is not selectable | Column grants |
| Use an unknown, malformed or revoked key | 401 | `api_key_resolve()` |
| Use a key to reach Settings, owner powers, other workspaces, or to mint more keys | Refused | The API acts as the member who created the key, capped by the key's scope ("look only" or "look and make changes"); key and webhook policies exclude API tokens |
| Keep using a key after it is revoked or its member loses access | Refused on the next call | Resolved per request |
| Present a web session, or a database token signed with the wrong secret, as an API caller | Refused | Token verification in the database |

### Rate limits

Per caller, per minute: 120 AI calls, 10 AI deletes, 120 API reads, 60 API writes. Counted in the database per key or AI app; over the allowance the API answers 429. This closes the Phase 1 weakness "no rate limiting" for the two machine channels. The web app itself is still not rate limited.

### Webhooks

| Attack | Result | Stopped by |
| --- | --- | --- |
| Point a webhook at an internal address (loopback, private ranges, link-local, IPv6 equivalents) | Refused at delivery time | Address check after DNS lookup; redirects are not followed; https only, no credentials in the URL |
| Read a webhook's signing secret back | Not possible | Shown once; column not selectable |
| Use a webhook to receive data from a page its creator cannot see | Event not sent | The creator's access is checked again at every event |
| Forge a delivery | Receiver can detect it | `X-Bizzy-Signature`: HMAC-SHA256 over timestamp and exact body |
| A member claiming or reporting deliveries | Refused | Those two functions are granted to the service role only |

Failed deliveries are retried with growing delays and given up after 6 attempts.

### Customers, Money and CSV

- Both pages follow the same levels as everything else (view, edit, manage); making an invoice from a deal needs access to both.
- Invoice lines lock once the invoice is sent; totals always equal the lines.
- CSV export prefixes cells that a spreadsheet would run as a formula. Exports are recorded in the audit log.

## Carried over from Phase 1, now closed

1. **Orphaned files.** A daily job (`/api/cron/files`, worker in `src/server/files/cleanup.ts`) removes stored objects older than a day that no file row points to. These come from uploads that were never confirmed and from deletes that failed half-way. Deleting a doc now removes rows before objects, so a failure leaves something the sweep can find. Tested: an old abandoned upload is removed; a recent one and a recorded file are kept; members cannot call the listing function.
2. **File size and type came from the browser.** A database trigger now refuses a file row for an object that does not exist and copies size and type from storage, whatever the client sent. This holds for the raw API too. Tested with a browser that lies about both.
3. **Fresh-login rule and token refresh.** Checked against a real local session: refreshing the token keeps the original sign-in timestamp in the `amr` claim, so a session kept alive by silent refreshes does not stay "fresh". A test now guards this. Still to confirm on a hosted project, where the Auth server version may differ.

## Known weaknesses, accepted for now

| Weakness | Risk | Plan |
| --- | --- | --- |
| The service-role key is now used by two workers (webhook delivery, file cleanup) instead of one | A bug in either runs without RLS | Each calls only fixed database functions and, for cleanup, removes exactly the paths one function returns; a test fails if any other file touches the key |
| The recorded file type is what the uploader declared to storage | A file can be labelled as another type | Downloads are forced as attachments with the stored name; do not render uploads inline |
| The cleanup job needs `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` | Without them orphans are simply never removed | Documented in DEPLOY.md |
| A file row can outlive its object if someone with Docs manage deletes the object through the storage API directly | The download link fails with "not found" | Low; cosmetic |
| The web app has no rate limit | A member could hammer search or flood the audit log with denials | Phase 4 hardening |
| Webhook cron sweep runs once a day (Vercel Hobby limit) | A failed delivery may wait up to a day for its retry | Shorten the schedule on a paid plan |
| `SUPABASE_JWT_SECRET` can sign a token for any user | Same blast radius as the service-role key | Kept server-side only, marked Sensitive in Vercel |
| No Content-Security-Policy header yet | Defence in depth only | Phase 4 hardening |
| No end-to-end browser tests | UI regressions are caught only by hand | Playwright flows, planned |
