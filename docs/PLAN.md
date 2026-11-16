# Bizzy: build plan (Step 1, awaiting approval)

Source: "Multi-Business Management App: Product Spec and Build Prompt" (Nov 12, 2026).
Decision already made: **Supabase** is the backend platform.
Status: plan only. No code is written until this is approved.

---

## 1. What Supabase changes

Supabase replaces several separate services the spec listed, so there is less to wire up and pay for.

| Spec concern | Spec suggestion | Plan with Supabase |
| --- | --- | --- |
| Database | Hosted Postgres, pooled | Supabase Postgres through the Supavisor pooler (transaction mode) |
| Login, sessions | Email + OAuth login, 2FA | Supabase Auth, email and password only for now. Google sign-in and 2FA are deferred until the app opens to the public |
| OAuth 2.1 for MCP clients | Build an OAuth provider | Supabase Auth's OAuth 2.1 server (PKCE, client registration); our app hosts the consent screen. To be verified in Phase 2, see risks |
| Row-level security | Second line of defense | Native: every request runs as the signed-in user, so RLS always applies |
| Files | Vercel Blob or S3 | Supabase Storage, one path prefix per workspace, signed URLs |
| Queue and cron | Vercel Cron + managed queue | Supabase Queues (pgmq) drained by Vercel Cron route handlers; jobs are resumable rows |
| Realtime | Polling or managed provider | Polling in Phase 1; Supabase Realtime later where it earns its place |
| Billing | Stripe | Stripe (unchanged, Phase 4) |

Hosting stays as specified: Next.js App Router on Vercel, stateless, `/api/mcp` as a stateless streamable-HTTP route handler.

## 2. Architecture overview

```
Browser ──► Next.js on Vercel ──┐
REST API (API keys) ────────────┼──► service layer ──► authorize() ──► Supabase Postgres (RLS)
AI client ──► /api/mcp ─────────┘        (one per module)                 Storage / Queues / Auth
```

- **One service layer.** Each module has a `service.ts` (for example `tasks/service.ts`). Web server actions, REST routes and MCP tools are thin wrappers that all call the same service functions. No entry point talks to the database directly.
- **Every service function starts with `authorize()`.** A lint rule and a test fail the build if a service function does not.
- **The database is queried as the user.** The server uses the caller's Supabase JWT, never the service-role key, for workspace data. If application code has a bug, RLS still blocks the row.
- **The service-role key** is used only by cron/queue workers and the audit writer, in one isolated file.
- **No client-side database access.** The browser never queries Supabase tables directly; it only uses Supabase Auth for the session. This keeps one enforcement path.

## 3. Data model

Every table except `profiles` has `workspace_id NOT NULL`, an index on it, and RLS enabled with default deny.

**Tenancy and access (Phase 1)**

| Table | Key columns | Notes |
| --- | --- | --- |
| `profiles` | `id` (= auth user id), `display_name`, `email` | One per login |
| `workspaces` | `id`, `name`, `slug`, `owner_id`, `mcp_policy` (`off`/`read_only`/`read_write`) | `owner_id` is "the creator"; changes only through ownership transfer |
| `roles` | `id`, `workspace_id`, `name`, `kind` (`full_access`/`custom`/`guest`), `is_builtin` | Full Access is one built-in row per workspace with no permission rows; the access function treats it as `manage` everywhere, so future pages are covered automatically |
| `role_permissions` | `role_id`, `workspace_id`, `page`, `level` (`view`/`edit`/`manage`), `sensitive` (bool) | Missing row = `none` |
| `memberships` | `workspace_id`, `user_id`, `role_id` (nullable), `expires_at` (nullable) | `role_id` null = no access. `expires_at` implements guest expiry |
| `invites` | `workspace_id`, `email`, `token_hash`, `invited_by`, `expires_at`, `accepted_at` | Accepting creates a membership with `role_id = null` |
| `audit_log` | `workspace_id`, `actor_id`, `channel` (`web`/`api`/`mcp`), `event`, `target`, `summary` (jsonb), `outcome` | Append-only: no update or delete policy exists. Readable by the owner only |
| `notifications` | `workspace_id`, `user_id`, `kind`, `payload`, `read_at` | |

The owner is not a role row. Ownership is derived from `workspaces.owner_id`, so there can only ever be one, and no role edit can create a second.

**Modules**

| Phase | Tables |
| --- | --- |
| 1 | `projects`, `tasks`, `task_comments`, `task_templates`, `docs` (tree via `parent_id`), `files` |
| 2 | `mcp_connections`, `mcp_connection_workspaces`, `api_keys`, `webhooks`, `webhook_deliveries`, `rate_limits`, `companies`, `contacts`, `deal_stages`, `deals`, `quotes`, `invoices`, `invoice_lines`, `expenses`, `budgets` |
| 3 | `employees`, `employee_compensation`, `leave_requests`, `onboarding_checklists`, `saved_reports`, `workspace_templates` |
| 4 | `inventory_items`, `vendors`, `orders`, `campaigns`, `content_items`, `tickets`, `automations`, `automation_runs`, `subscriptions` |

**Sensitive fields.** RLS works on rows, not columns, so sensitive fields live in side tables (`employee_compensation`, `deal_margins`) whose policy requires the `sensitive` flag on the caller's role for that page. A role can then see HR without seeing salaries.

## 4. Permission model and `authorize()`

**One source of truth, in SQL.** A single Postgres function resolves access, and both RLS policies and the TypeScript `authorize()` use it, so the two cannot drift apart.

```
access_level(workspace_id, page) → none | view | edit | manage
  not a member                         → none
  membership expired                   → none
  caller is workspaces.owner_id        → manage
  role_id is null                      → none
  role.kind = full_access              → manage
  otherwise                            → role_permissions row, or none
```

RLS policies on every module table are the same four lines: select needs `view`, insert/update needs `edit`, delete needs `manage`, all on that table's page.

**TypeScript side**

```ts
authorize(ctx, workspaceId, page, action): Promise<void>   // throws PermissionDenied
```

- `ctx` = user, channel (`web`/`api`/`mcp`), and for MCP the connection.
- It makes one call per request to `my_access(workspace_id)`, which returns the caller's page → level map from the SQL function above, then compares levels. Nothing is cached between requests, so revocations apply on the next call.
- Every denial is written to `audit_log`.
- For MCP it also applies, in order: connection not revoked, workspace is in the connection's chosen set, workspace `mcp_policy` (`off` denies all, `read_only` denies anything above `view`).

**Owner-only actions** are a separate, closed list that no role level can reach: `roles.manage`, `membership.set_role`, `membership.remove`, `ownership.transfer`, `workspace.delete`, `mcp.set_policy`, `mcp.revoke_any`, `audit.read`, `billing.manage`.

Three independent locks protect role granting:

1. `authorize()` rejects it unless `ctx.user.id = workspace.owner_id` and the channel is `web`.
2. RLS on `roles`, `role_permissions` and `memberships` allows writes only when `auth.uid() = owner_id`, and denies any token issued to an OAuth client (so an MCP token cannot write them even if a tool existed).
3. The action requires a fresh re-authentication (password re-entry within the last 10 minutes; a 2FA code once 2FA is added).

A trigger blocks deleting or demoting the owner's own membership. Ownership transfer is a single database function: confirm, swap `owner_id`, write the audit row, all in one transaction.

## 5. MCP tools per page and level

Endpoint: `/api/mcp`, stateless streamable HTTP. Each call carries a Supabase-issued OAuth access token; the server resolves user and connection, then calls the same service functions as the web app.

| Page | Needs `view` | Needs `edit` | Needs `manage` |
| --- | --- | --- | --- |
| (membership only) | `list_workspaces`, `get_workspace_summary` | | |
| Tasks | `list_tasks`, `get_task`, `list_projects` | `create_task`, `update_task`, `comment_on_task` | `delete_task` (confirm) |
| Docs | `search_docs`, `read_doc` | `create_doc`, `update_doc` | `delete_doc` (confirm) |
| CRM | `search_contacts`, `list_deals`, `get_deal` | `create_contact`, `create_deal`, `move_deal_stage` | `delete_deal` (confirm) |
| Finance | `list_invoices`, `list_expenses`, `get_cash_flow` | `create_invoice`, `create_expense`, `send_invoice` (confirm) | `delete_invoice` (confirm) |
| Dashboard | `get_cross_workspace_overview` | | |
| HR (Phase 3) | `list_people`, `list_leave` | `request_leave`, `update_person` | `approve_leave` |
| Roles, members, MCP policy, billing | **never exposed** | | |

- **Listing.** A connection can cover several workspaces, so a tool is listed if the member's role allows it in at least one exposed workspace under that workspace's MCP policy. Every tool takes `workspace_id` and is checked again on the call.
- **Destructive tools** require `confirm: true` plus the exact target id, and have a tighter rate limit.
- **Stored content** is returned inside a clearly delimited plain-string field, never merged into tool descriptions or instructions.
- **Logging.** Every call writes user, workspace, tool, argument summary (no free-text bodies) and outcome.

## 6. Folder structure

```
bizzy/
  src/
    app/
      (auth)/                 sign-in, sign-up, 2FA, invite accept
      (app)/[workspace]/      tasks/ docs/ crm/ finance/ hr/ settings/ ...
      (app)/overview/         cross-workspace dashboard
      oauth/consent/          MCP consent screen (workspace picker)
      api/v1/                 public REST API
      api/mcp/route.ts        MCP endpoint
      api/cron/               queue drain, guest expiry, webhooks
    server/
      authz/                  authorize.ts, pages.ts, actions.ts, errors.ts
      db/                     user-scoped client, admin client (isolated), generated types
      audit/
      modules/<module>/       service.ts, schema.ts (zod)
      mcp/                    server.ts, registry.ts, tools/<module>.ts
    components/  lib/
  supabase/
    migrations/               SQL: tables, access functions, RLS policies
    seed.sql
  tests/
    authz/  isolation/  mcp/  e2e/
  docs/                       PLAN.md, DEPLOY.md, DEMO-phase-N.md
  .env.example
```

## 7. Testing strategy

| Layer | Tool | What it proves |
| --- | --- | --- |
| Authorization matrix | Vitest, generated cases | Every role × page × action gives the expected allow/deny, through the real service functions |
| Tenant isolation | Vitest against a real Supabase database | User A in workspace 1 gets zero rows and failed writes on every workspace 2 table. A meta-test fails if any table lacks RLS or a `workspace_id` |
| RLS bypass | Vitest calling Supabase directly with a user JWT, skipping our app | The database alone refuses what the app would refuse |
| Role granting | Vitest | Full Access, custom role, guest, no-role and MCP tokens all fail to create/edit/assign roles; the owner cannot be demoted |
| MCP scoping | Vitest with an MCP client | Sales member sees no Finance tools and gets a logged denial on a forced call; revoking a role or connection applies on the very next call; policy `off` and `read_only` hold |
| End to end | Playwright, a handful of flows | Sign up, create workspace, invite, assign role, member sees only their pages |

Tests run in GitHub Actions on every pull request. The security self-review at the end of each phase (Step 3 of the spec) is written up in `docs/`.

## 8. Phases and tasks

**Phase 1: Foundation (live on Vercel at the end)**

1. Repo, Next.js, TypeScript, lint, CI, `.env.example`
2. Supabase project(s), migrations pipeline, first Vercel deploy (empty shell, real URL)
3. Auth: email and password sign-in, profiles
4. Workspaces, switcher, owner model
5. Access functions, RLS, `authorize()`, audit log
6. Invites and members (join with no role)
7. Roles UI: permission matrix, Full Access, guest with expiry, re-auth gate, ownership transfer
8. Tasks: projects, boards and lists, assignees, due dates, recurring, comments, templates
9. Docs: tree, editor, file uploads to Storage
10. Audit log viewer, notifications, global search
11. Test suites, security self-review, demo script, `DEPLOY.md`

Acceptance: a Full Access holder cannot change any role; a no-role member sees nothing; isolation tests pass.

**Phase 2: MCP and business core.** OAuth 2.1 consent flow, `/api/mcp`, Tasks and Docs tools, connections page, owner MCP policy, rate limiting, CRM, Finance basics, REST API with keys, webhooks, CSV import/export.
Acceptance: a Sales member's AI client cannot list or call Finance tools; revocation applies on the next call.

**Phase 3: Overview and people.** Cross-workspace dashboard (calls `authorize()` per workspace and page, then aggregates), HR with sensitive compensation, notifications, reports, business templates.
Acceptance: the dashboard shows only workspaces and pages the viewer may access.
Built Nov 16, 2026. What differs from this plan (templates defined in code, no onboarding checklists or HR notifications yet) is listed in [SECURITY-REVIEW-phase-3.md](SECURITY-REVIEW-phase-3.md).

**Phase 4: Scale and polish.** Operations, Marketing, Support, automations, in-app AI assistant (through the same service layer), Stripe billing, SSO, mobile polish, load test, security review.

### Work that can be done before deploying (planned Nov 16, 2026)

Everything below can be built and tested on the local Supabase stack. Every step ends with the same closing tasks: database tests for allow/deny and tenant isolation, a browser test for the main flow, lint + type-check + build, and a line in the security review.

**Stage A: close the Phase 3 gaps**

1. **Push the branch and get CI green.** *Done Nov 16, 2026.* Push `phase-3-e2e-and-overview`, open a pull request, fix whatever the browser tests turn up against the production build.
2. **HR notifications.** *Done Nov 16, 2026.* Notification kinds for "time off requested" and "time off decided"; written from the HR service; shown on the notifications page.
3. **Self-service time off.** Link a person record to a member; a policy letting a member insert and view leave requests for their own person record only; a "My time off" page visible without HR access; test that a member cannot file for someone else or approve their own.
4. **Sick leave privacy.** Hide the kind of leave unless the caller has HR private details or it is their own request; apply it in the HR list, the `list_leave` AI tool and the reports.
5. **Report sums in SQL.** Move each report's totals into a SECURITY INVOKER function; remove the 10,000-row read; check totals match the old results on seeded data.
6. **REST API for HR, reports and overview.** `/api/v1` routes wrapping the existing services; API key scopes for the new pages; no pay changes through the API.
7. **Onboarding checklists and re-appliable templates.** An `onboarding_checklists` table tied to a person, with RLS on the HR page; start a checklist when a person is added; apply a template from Settings, skipping items that already exist.

**Stage B: hardening**

8. **Content-Security-Policy.** Read the Next.js guide for headers and nonces; add the header in `src/proxy.ts` in report-only mode; walk every page, fix violations, then enforce.
9. **Web rate limit.** Reuse `rate_limits` for server actions, keyed by user; tighter limits on search, sign-in and anything that writes audit denials; a plain "slow down" message.
10. **Two-factor sign-in.** Enrol, verify and remove screens using Supabase Auth's authenticator-app support; require a code in the re-authentication gate for owner-only actions; recovery guidance for a lost device.
11. **Google sign-in.** The owner creates the Google OAuth credentials; wire the button and callback; handle an existing email-and-password account with the same address.

**Stage C: Phase 4 modules**

Steps 12–14 follow one pattern: migration with tables and RLS, a page in `authz/pages.ts`, service with `authorize()`, web pages, AI tools, REST routes, CSV import/export, and a section in the overview.

12. **Support.** `tickets` and ticket comments; status, priority, assignee, link to a contact. AI tools: list, get, create, update, comment; delete with confirm.
13. **Operations.** `inventory_items`, `vendors`, `orders`, order lines; stock changes when an order is received or fulfilled, inside one database function; low-stock notification.
14. **Marketing.** `campaigns` and `content_items` with a calendar view; link a campaign to deals for a simple results figure.
15. **Automations.** `automations` and `automation_runs`; a closed list of triggers (task done, deal moved, invoice overdue, ticket opened) and actions (create task, notify, call webhook); run through the queue as the automation's creator, re-checking their access on every run; test that removing the creator's role stops the automation.
16. **Mobile polish.** Every page at phone width; fix navigation, tables and forms.

**Stage D: needs outside accounts**

17. **Stripe billing (test mode).** The owner creates the Stripe account and test keys. `subscriptions` table; checkout, customer portal, webhook handler with signature checks; plan limits enforced in the service layer; `billing.manage` stays owner-only; tested with the Stripe CLI forwarding webhooks to localhost.
18. **In-app AI assistant.** The owner supplies a Claude API key. A chat panel calling the same tool registry as `/api/mcp`, as the signed-in user; obeys the workspace AI policy; asks for confirmation before any destructive tool; stored content is treated as data, tested with a doc that contains planted instructions.
19. **Local load test and Phase 4 security review.** Seed a large workspace and time the slow pages and the overview; add indexes where needed; write `SECURITY-REVIEW-phase-4.md` and `DEMO-phase-4.md`.

**Left out:** SSO, because it cannot be meaningfully tested without a real identity provider.

**Needs a real deployment:** running `DEPLOY.md` end to end, Vercel Cron on a schedule, real email delivery, AI clients that only connect to public HTTPS addresses, production Stripe, meaningful load numbers.

## 9. Points in the spec I resolved, please confirm

The spec asks me to flag conflicts rather than choose silently. These are my proposed readings.

1. **"Creator" after an ownership transfer.** The spec says only the creator grants roles, and also allows ownership transfer. I treat "creator" as "current owner": after a transfer the new owner holds every owner power and the previous one becomes a normal member with no role.
2. **Removing a member.** Removal revokes a role, so only the owner can do it. Full Access holders can send and cancel invites (which carry no access) but cannot remove members.
3. **MCP tool listing across several workspaces.** One token can cover several workspaces with different roles, so "not listed" is evaluated across the exposed set (section 5) and enforced exactly on each call.
4. **Sensitive fields** are implemented as side tables, not a per-column flag, because that is what RLS can actually enforce.
5. **Vercel Blob and a separate managed queue are dropped** in favour of Supabase Storage and Supabase Queues.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Supabase's OAuth 2.1 server may not cover everything MCP clients need (client registration, per-workspace consent) | Spike it in the first two days of Phase 2. Fallback: a small self-hosted OAuth provider in the same Next.js app, storing grants in Postgres. Nothing in Phase 1 depends on the outcome |
| Access logic drifting between SQL and TypeScript | Levels are resolved only in SQL; TypeScript only compares them. The RLS bypass tests catch gaps |
| Serverless connection exhaustion | Supabase HTTP API for app queries, pooler in transaction mode for migrations and workers |
| Preview deployments need a database | Supabase branching (paid plan) gives each pull request its own database; on the free plan previews share one "preview" project |
| Local Supabase needs Docker Desktop (roughly 8–12 GB disk, about 4 GB RAM while running) | Decided: install Docker Desktop. Fallback if it proves troublesome: a cloud dev/test Supabase project |
| Tiptap/editor and recurring-task scope creep in Phase 1 | Ship plain rich text and simple recurrence rules first |
| Vercel function time limits for exports and automations | All long work goes through the queue in resumable chunks |

## 11. Decisions (Nov 12, 2026)

1. **Accounts.** Repo: https://github.com/TreeTheCreator/Bizzy. The Vercel and Supabase accounts exist and are managed by the owner, who creates the projects and enters keys in `.env.local` and Vercel's environment settings.
2. **Supabase plan.** Free. Preview deployments share one database; there is no per-pull-request database.
3. **Local database.** Docker Desktop with a local Supabase stack for development and tests.
4. **Sign-in methods.** Email and password only. The first users are the owner and selected people; 2FA and Google sign-in come later, before public use.
5. **Name.** Bizzy.
