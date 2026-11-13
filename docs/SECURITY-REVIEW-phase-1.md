# Phase 1 security self-review

Nov 12, 2026. Reviewed as an attacker would: try to grant yourself a role, reach another workspace, or read something your role excludes.

## What has and has not been verified

Updated Nov 13, 2026, after the first runs against a real local Supabase stack.

| Check | Status |
| --- | --- |
| Full test suite: 375 tests (130 unit, 245 against real Supabase Postgres, Auth and Storage) covering the access matrix, role granting, tenant isolation, audit, invites and files | **Run, all passing** |
| The fresh-login rule against a real Supabase session (the `amr` token claim has the shape the database function expects) | **Confirmed** by the test suite |
| Demo script walked in a browser with two test users: sign-up, workspace, invite, "No access yet", role creation and assignment, restricted Sales view, recurring task, doc and file upload, search, immediate revocation, audit log, notifications | **Done, working** |
| GitHub Actions CI | **Not run yet** (nothing has been pushed) |
| A real Vercel + Supabase cloud deployment, including email confirmation and migrations on deploy | **Not done** |

What the first real runs found:

- **Partial updates wiped unsent fields.** The validation library applies defaults inside partial schemas, so "mark done" reset a task's recurrence and renaming a doc cleared its content. Caught by two failing tests; fixed by separating create rules (with defaults) from update rules (without); regression test added.
- **Audit log showed role ids instead of names.** Now shows member and role names and what changed (for example "Sales → no role").

Not verified in the browser walkthrough: the password re-confirmation prompt (every owner action was within 10 minutes of sign-in; the rule itself is covered by tests), ownership transfer, workspace deletion, guest expiry and templates. These are covered by the automated tests but nobody has clicked them.

Known rough edge: signing in after being redirected from a deep link returns you to the workspace home, not the page you asked for.

## Attacks tried, by rule

### Role granting (rule 1)

| Attack | Result | Stopped by |
| --- | --- | --- |
| Full Access holder calls the role, membership, transfer or delete services | Refused | `authorize()` owner check |
| Same, straight at the database API, skipping the app | Refused | RLS `can_manage_roles()` on `roles`, `role_permissions`, `memberships` |
| Insert your own membership row with a role | Refused | No insert policy or grant exists; only `create_workspace()` and `accept_invite()` insert, always with no role |
| `update workspaces set owner_id = me` | Refused | Guard trigger: ownership only changes inside `transfer_ownership()` |
| Create a second Full Access role, or edit the built-in one | Refused | Guard trigger on `roles` |
| Call `save_role()` directly | Refused | It is SECURITY INVOKER, so RLS still applies |
| Demote or remove the owner (even as the owner) | Refused | Guard trigger on `memberships` |
| Owner's stolen session, no password | Refused for role changes | 10-minute fresh-login rule, checked in `authorize()` and again in RLS |
| Owner's token issued to an AI client | Refused | `is_oauth_client()` in every role policy; `authorize()` requires the web channel |
| Give a guest role `manage` or Settings | Refused | Guard trigger on `role_permissions` |
| Assign a role that belongs to another workspace | Refused | Composite foreign key `(role_id, workspace_id)` |

### Tenant isolation (rule 7)

| Attack | Result | Stopped by |
| --- | --- | --- |
| Read another workspace's rows via the API | Zero rows | RLS on every table |
| Ask for another workspace's task id inside your own workspace | Not found | Services always filter by `workspace_id` as well as id |
| Point a task at another workspace's project or person, or a doc at another workspace's parent | Refused | Composite foreign keys including `workspace_id` |
| `update tasks set workspace_id = other` | Refused | `guard_workspace_id` trigger, plus RLS `with check` |
| Read or write another workspace's files | Refused | Storage policies key on the first path segment; the server builds the path, never the client |
| Signed-out access | Nothing | `anon` has no table grants and can execute no function |

### Things a member should not see

| Attack | Result |
| --- | --- |
| No-role member opens any page or queries any table | Nothing; only their own membership row and the workspace name |
| Non-owner reads the audit log | Refused in the service and by RLS |
| Edit, delete or forge audit entries | No update/delete policy exists; role history is written by triggers; the app-level writer accepts only `authz.denied`, `data.export`, `mcp.call` and forces the actor to be the caller |
| Search for content in a page you cannot view | That page is not queried |

## Issues found during this review and fixed

1. **Profile email could be changed by its owner.** Invites are matched to the caller's profile email, and owners read that email when assigning roles. A user could have set their profile email to someone else's address and then used that person's invite link, or impersonated them in the member list. **Fix:** clients may now update only `display_name`. Test added.
2. **Task titles could leak through notifications.** Assigning a task to a member without Tasks access wrote a notification containing the title, which they could read. **Fix:** notifications are only written for people who can view Tasks, and reading a task notification also requires Tasks view at that moment. Tests added.
3. **Functions were executable by everyone by default.** Postgres grants `EXECUTE` to `PUBLIC` on new functions, so internal helpers (the audit writer, the any-user access resolver) would have been callable. **Fix:** every migration revokes and then grants an explicit list; a test compares the live list against an allowlist.

## Known weaknesses, accepted for now

| Weakness | Risk | Plan |
| --- | --- | --- |
| No rate limiting in the app (Supabase Auth has its own for sign-in) | A member could flood the audit log with denials, or hammer search | Phase 2, with the API and MCP server |
| Display names are free text | A member could name themselves like the owner in comments | Show email next to name in sensitive places; revisit in Phase 3 |
| Signed file links live 60 seconds; upload tokens about 2 hours | Someone whose access was just revoked can finish a download or upload in that window. An upload without a recorded row is invisible in the app | Acceptable; orphan cleanup job in Phase 2 |
| Recorded file size and type come from the browser | Could be wrong; the real limit (25 MB) is enforced by storage | Read them back from storage in Phase 2 |
| The fresh-login rule trusts the `amr` timestamp in Supabase's token | A fresh sign-in is confirmed to count. Not yet checked: whether a silent token refresh also renews the timestamp, which would make the rule weaker than intended (never bypassed) | Check with a session older than one hour |
| Sign-up is open | Strangers can create accounts and their own workspaces; they cannot see yours | Switch sign-ups off in Supabase once the team has joined (see DEPLOY.md) |
| No Content-Security-Policy header yet | Defence in depth only; React escapes all output and stored content is rendered as plain text | Phase 4 hardening |
| Editors can overwrite `created_by` on tasks through the raw API | Cosmetic attribution only | Lock with a trigger when reports depend on it |
| Members with any access can list other members' display names | Needed for assignee pickers | By design; emails stay restricted to Settings view |
| Role, member and workspace changes are several API calls, not one transaction, in a few services (e.g. deleting a doc and its files) | A failure mid-way can leave an orphaned file object | Low; cleanup job in Phase 2 |

## Decisions made while building

- **No 2FA or Google sign-in yet**, as agreed. The fresh-login check is a password re-entry.
- **Invites are links, not emails.** The app has no email sender yet; the inviter copies the link. The link only works for the invited address.
- **Docs are plain text.** No rich-text editor in Phase 1; content is stored and shown verbatim.
- **MCP policy defaults to `off`** for new workspaces. The column exists; enforcement arrives with the MCP server in Phase 2.
- **Previous owner after a transfer** keeps membership with no role, as agreed.
- **Sensitive-field flag** is stored on role permissions and resolved by `can_see_sensitive()`, but no Phase 1 page has sensitive fields, so nothing reads it yet.
- **The experimental Next.js caching features** the template enables were switched off: every page is per-user.
- **Database types are hand-written** in the service files. Generating them from the schema (`npm run db:types`) needs the local stack and is the first follow-up.
