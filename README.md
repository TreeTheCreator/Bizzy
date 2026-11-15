# Bizzy

Run several businesses from one place. Each business is a **workspace**; the workspace owner decides, page by page, what every member can see and do.

Status: **Phase 1 (Foundation)**. Accounts, workspaces and switcher, invites, owner-only role management, page-level permissions, the built-in Full Access role, guest roles with expiry, audit log, Tasks, Docs with file storage, notifications and search.

- Plan and decisions: [docs/PLAN.md](docs/PLAN.md)
- Deploying to Vercel + Supabase: [docs/DEPLOY.md](docs/DEPLOY.md)
- Phase 1 demo script: [docs/DEMO-phase-1.md](docs/DEMO-phase-1.md)
- Phase 1 security self-review: [docs/SECURITY-REVIEW-phase-1.md](docs/SECURITY-REVIEW-phase-1.md)

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
| `npm run db:reset` | Wipe the local database and re-apply all migrations |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm run db:stop` | Stop the local Supabase containers |

## How permissions work

There is one authorization layer and everything goes through it.

1. **The database decides.** `public.access_level(workspace, page)` resolves the caller's level (`none`, `view`, `edit`, `manage`). Row-level security policies on every table call it.
2. **The app asks the same function.** `authorize(ctx, workspaceId, page, action)` in [src/server/authz/authorize.ts](src/server/authz/authorize.ts) reads the same result and throws if it is not enough. Every service function in `src/server/modules/*/service.ts` starts with it; a test fails the build otherwise.
3. **Entry points are thin.** Pages and server actions only call service functions. The API and MCP server (Phase 2) will call the same ones.
4. **The owner is not a role.** Ownership is `workspaces.owner_id`. Only the owner can create, edit, delete or assign roles, only from the web app, and only within 10 minutes of typing their password. Three independent checks enforce this: `authorize()`, the RLS policies, and database triggers.

Queries always run as the signed-in user (or, for the REST API, as the member who created the API key). The Supabase service-role key is used in exactly one place: the webhook delivery worker (`src/server/webhooks/deliver.ts`), which only claims queued deliveries and records their results. A test fails if any other file touches it.

## Layout

```
src/app/                  pages and server actions (thin)
src/server/authz/         authorize(), pages, levels, owner-only actions
src/server/modules/*/     service functions: the only code that touches data
supabase/migrations/      schema, access functions, RLS policies, triggers
tests/unit/               no database needed
tests/db/                 role granting, tenant isolation, audit: against real Supabase
```
