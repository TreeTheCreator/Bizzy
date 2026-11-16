# Phase 3 security self-review

Nov 16, 2026. Covers what Phase 3 added: the cross-workspace overview, HR with sensitive pay and time off, reports, and business templates. Earlier reviews still stand: [Phase 1](SECURITY-REVIEW-phase-1.md), [Phase 2](SECURITY-REVIEW-phase-2.md).

## What has and has not been verified

| Check | Status |
| --- | --- |
| Full test suite: 523 tests against real local Supabase Postgres, Auth and Storage | **Run, all passing** |
| Browser tests (Playwright, 11 tests, two signed-in sessions): roles, overview, HR and pay, reports, templates | **Run, all passing** locally against the dev server |
| Lint, type-check and production build | **Run, all passing** |
| Phase 3 acceptance: the dashboard shows only workspaces and pages the viewer may access | **Confirmed** by `tests/db/overview.test.ts` and `e2e/overview.spec.ts` |
| Browser tests in CI (they run there against the production build, not the dev server) | **Not run yet**: this branch has not been pushed |
| HR, reports and overview through a real AI app | **Not verified.** The tools are covered by the tool-listing tests only |
| A real Vercel + Supabase deployment | **Not done** |

## Attacks tried, by area

### Cross-workspace overview

| Attack | Result | Stopped by |
| --- | --- | --- |
| See a business you are not a member of | Not listed | `my_overview()` only lists workspaces where `access_level(…, 'dashboard') >= view`; RLS on `workspaces` as well |
| See a business where your role has pages but not the Dashboard | Not listed | Same check |
| See Money or Customers numbers with a role that only includes Tasks | That section is null; totals leave it out | Per-page `access_level()` inside the function; RLS on every table it reads |
| Keep seeing a business after the role is taken away | Gone on the next call | Nothing is cached |
| Call the function with an AI app's token that is not connected to the business | Empty list | `access_level()` already applies the connection and the AI policy |
| Call it signed out | No access | Not executable by `anon` |

The function is SECURITY INVOKER: a mistake in its conditions could hide numbers but could not reveal them, because RLS still applies to every row it reads.

### HR and pay

| Attack | Result | Stopped by |
| --- | --- | --- |
| Read pay with a role that includes HR but not its private details | No pay rows, through the app or the raw database API | Every policy on `employee_compensation` also requires `can_see_sensitive(workspace, 'hr')` |
| Add, change or remove pay with HR edit but no private details | Refused | Same policies; the service checks it first |
| Read pay through an AI app | Only if the member's own role includes private details; there is no AI tool that changes pay | RLS; no such tool exists |
| Change pay without a trace | Not possible | A trigger writes `hr.pay_changed` / `hr.pay_removed` to the activity log, with who and for whom, never the amount |
| Keep seeing pay after private details are removed from the role | Hidden on the next call | Resolved per call |
| Approve your own time off with only HR edit | Refused | Update policy needs manage |
| Insert a request that is already approved | Stored as pending, with no decision | `leave_before_write` trigger |
| Rewrite a request's dates, or who decided it, after the fact (even as the owner) | Refused, or ignored for the decision stamp | Same trigger: only the decision may change, and it is stamped with the caller |
| Tie a person to a member of another workspace, or request time off for another workspace's person | Refused | Composite foreign keys including `workspace_id` |

### Reports

| Attack | Result | Stopped by |
| --- | --- | --- |
| Run a report over a page your role lacks | Refused | `authorize()` on the report's page; the queries run under RLS anyway |
| See or open someone's saved Money report with a Tasks-only role | Not listed, not selectable | RLS: `access_level(workspace, report_page(kind)) >= view` |
| Save a report with a look-only role | Refused | Insert needs edit on the report's page |
| Delete someone else's saved report with edit | Not found | Delete needs manage, or being the one who saved it |
| Save a report of a made-up kind | Refused | Check constraint through `report_page()` |

A saved report stores a name, a kind and a period. It never stores numbers. Report downloads are written to the activity log.

### Business templates

A template is applied through the ordinary Tasks and Docs services, as the person applying it, and needs Settings manage. It cannot do anything that person could not do by hand. An unknown template name is refused.

## Decisions and deviations from the plan

- **Templates are defined in code**, not in a `workspace_templates` table. They are offered only when a business is created.
- **Onboarding checklists** (`onboarding_checklists` in the plan) are not a separate feature: the templates add a "New team member" ready-made task list instead.
- **Time off has no self-service.** Someone with HR edit files a request for a person; there is no "request my own leave" for members without HR access.
- **Notifications for HR** (for example, when a request is decided) are not built.
- **The REST API does not cover HR, reports or the overview.** AI tools do: `list_people`, `list_leave`, `request_leave`, `update_person`, `approve_leave`, `get_cross_workspace_overview`.
- **Reports use UTC** month and year boundaries.

## Known weaknesses, accepted for now

| Weakness | Risk | Plan |
| --- | --- | --- |
| A role with HR edit can change a person's name, job and contact details, including their own | Low; no pay or access is involved | Fine for small teams |
| Anyone with HR view sees everyone's time off, including sick leave | Sick leave is personal information | Move the kind of leave behind private details if teams ask for it |
| Report queries read up to 10,000 rows and add them up in the app | Slow, and totals would be short, for a very large business | Move the sums into SQL when a real workspace gets near that size |
| The overview shows rounded money | Small differences against the Money page | By design; the Money page has exact amounts |
| Applying a template twice would create duplicates | Clutter only | It is only offered at creation |
