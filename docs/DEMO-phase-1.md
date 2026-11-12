# Phase 1 demo script

About 10 minutes. Use two browsers (or one normal and one private window) so you can be two people at once. Locally, sign-ups need no email confirmation.

**Setup:** `npm run db:start`, `npm run db:env`, `npm run dev`, open http://localhost:3000.

## 1. Owner creates a workspace

1. Browser A: Create account as `owner@example.com`. You land on "Your workspaces".
2. Create a workspace called `Acme`. You are shown as **Owner** in the sidebar.
3. Create a second workspace, `Side Project`, and switch between them from the workspace name at the top of the sidebar.

## 2. Invites carry no access

1. In `Acme`: Settings → Members → enter `cofounder@example.com` → **Create invite link**. Copy the link.
2. Browser B: open the link, create the account `cofounder@example.com`, accept the invitation.
3. **Expected:** Browser B shows "No access yet". No Tasks, no Docs, no Settings. Typing `/w/<id>/tasks` in the address bar also shows nothing.

## 3. Only the owner grants roles

1. Browser A: Settings → Members → set the co-founder's role to **Full Access** → Save. If it has been more than 10 minutes since you signed in, you are asked for your password first.
2. Browser B: refresh. Tasks, Docs and Settings appear.
3. Browser B: Settings → Members. **Expected:** the list is visible but there are no role controls, and the page says only the owner can change roles. Settings → Roles shows roles read-only. There is no Audit log tab.
4. Browser B: Settings → General. **Expected:** can rename the workspace, cannot transfer or delete it.

## 4. A custom role limits pages

1. Browser A: Settings → Roles → New role → name `Sales`, Tasks = `edit`, Docs = `view` → Create role.
2. Settings → Members → change the co-founder to `Sales`.
3. Browser B: refresh. **Expected:** Settings is gone from the sidebar. Tasks can be created and edited but there is no Delete button. Docs can be read but there is no New doc or Edit.

## 5. Tasks and Docs

1. Browser B (Sales): Tasks → New task → title `Call the client`, repeats `weekly`, assign to the owner → Create.
2. Switch to **Board** view. Set the task to Done. **Expected:** a new copy appears in To do, due a week later.
3. Browser A: the sidebar shows a notification badge. Open Notifications → click through to the task → add a comment.
4. Browser A: Docs → New doc → write some content → Save. Upload a file to it.
5. Browser B: open the doc. **Expected:** can read it and download the file, cannot edit or upload.
6. Either browser: use the Search box. **Expected:** results only from pages that person can see.

## 6. Revocation is immediate

1. Browser A: Settings → Members → set the co-founder to **No role** → Save.
2. Browser B: click anything. **Expected:** "No access yet", immediately, without signing out.

## 7. Audit log

Browser A: Settings → Audit log. **Expected:** sign-ins, the invite, the member joining, role creation, each role change (who, to whom), and "denied" rows for anything Browser B was refused.

## 8. Guest with an end date (optional)

1. Browser A: Roles → New role → Type **Guest**, Docs = `view` → Create. Note that `manage` is not offered and Settings cannot be granted.
2. Members → give the co-founder the guest role with an end date. After that date their access is `none`.
