# Bizzy

Run several businesses from one place. Each business is a **workspace**; the workspace owner decides, page by page, what every member can see and do.

Status: **Phase 3 (Overview and people)**, not yet deployed. Phase 3 adds an at-a-glance overview across all your businesses, HR with private pay and time off, reports, and business templates. Phase 2 added AI app connections (OAuth consent and an MCP endpoint), the owner's AI policy, Customers, Money, a REST API with keys, rate limits, webhooks and CSV import/export. Phase 1: accounts, workspaces and switcher, invites, owner-only role management, page-level permissions, the built-in Full Access role, guest roles with expiry, audit log, Tasks, Docs with file storage, notifications and search.

- Plan and decisions: [docs/PLAN.md](docs/PLAN.md)
- Deploying to Vercel + Supabase: [docs/DEPLOY.md](docs/DEPLOY.md)
- Phase 1 demo script: [docs/DEMO-phase-1.md](docs/DEMO-phase-1.md)
- Phase 1 security self-review: [docs/SECURITY-REVIEW-phase-1.md](docs/SECURITY-REVIEW-phase-1.md)
- Phase 2 demo script: [docs/DEMO-phase-2.md](docs/DEMO-phase-2.md)
- Phase 2 security self-review: [docs/SECURITY-REVIEW-phase-2.md](docs/SECURITY-REVIEW-phase-2.md)
- Phase 3 demo script: [docs/DEMO-phase-3.md](docs/DEMO-phase-3.md)
- Phase 3 security self-review: [docs/SECURITY-REVIEW-phase-3.md](docs/SECURITY-REVIEW-phase-3.md)

## Run it locally

Needs Node 24+ and Docker Desktop (running).

```bash
npm install
npm run db:start   # local Supabase: Postgres, Auth, Storage. First run downloads several GB.
npm run db:env     # writes the local URL and keys to .env.local
npm run dev        # http://localhost:3000
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests, plus the database tests when the local stack is running |
| `npm run test:e2e` | Browser tests (Playwright). Needs the local stack; first run: `npx playwright install chromium` |
| `npm run db:reset` | Wipe the local database and re-apply all migrations |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm run db:stop` | Stop the local Supabase containers |

## How permissions work

There is one authorization layer and everything goes through it.

1. **The database decides.** `public.access_level(workspace, page)` resolves the caller's level (`none`, `view`, `edit`, `manage`). Row-level security policies on every table call it.
2. **The app asks the same function.** `authorize(ctx, workspaceId, page, action)` in [src/server/authz/authorize.ts](src/server/authz/authorize.ts) reads the same result and throws if it is not enough. Every service function in `src/server/modules/*/service.ts` starts with it; a test fails the build otherwise.
3. **Entry points are thin.** Pages and server actions only call service functions. The API and MCP server (Phase 2) will call the same ones.
4. **The owner is not a role.** Ownership is `workspaces.owner_id`. Only the owner can create, edit, delete or assign roles, only from the web app, and only within 10 minutes of typing their password. Three independent checks enforce this: `authorize()`, the RLS policies, and database triggers.

Queries always run as the signed-in user (or, for the REST API, as the member who created the API key). The Supabase service-role key is used by two background workers only: webhook delivery (`src/server/webhooks/deliver.ts`), which claims queued deliveries and records their results, and orphaned-file cleanup (`src/server/files/cleanup.ts`), which removes stored files that no record points to. A test fails if any other file touches it.

## Layout

```
src/app/                  pages and server actions (thin)
src/server/authz/         authorize(), pages, levels, owner-only actions
src/server/modules/*/     service functions: the only code that touches data
supabase/migrations/      schema, access functions, RLS policies, triggers
tests/unit/               no database needed
tests/db/                 role granting, tenant isolation, audit: against real Supabase
```
