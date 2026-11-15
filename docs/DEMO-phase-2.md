# Phase 2 demo script

> Written from the code and the tests. It has **not yet been walked in a browser**; expect to adjust a label or two on the first run.

About 15 minutes. Use two browsers (or one normal and one private window). It continues from the [Phase 1 demo](DEMO-phase-1.md): an `Acme` workspace with an owner (Browser A) and a member with the `Sales` role (Browser B).

**Setup:** `npm run db:start`, `npm run db:env`, `npm run dev`, open http://localhost:3000. `npm run db:env` writes the local keys that switch on the API and webhooks.

## 1. Customers follow the role

1. Browser A: Settings → Roles → edit `Sales` → set Customers = `edit`, leave Money at no access → Save.
2. Browser B: refresh. **Expected:** Customers appears in the sidebar; Money does not.
3. Browser B: Customers → **Add company**, **Add contact**, **Add deal**. Move the deal along the stages.
4. **Expected:** there is no delete option for Browser B (delete needs `manage`).
5. Browser B: type `/w/<id>/finance` in the address bar. **Expected:** nothing is shown.

## 2. Money

1. Browser A: Money → **New invoice** → pick a customer → add two lines. **Expected:** the total equals the lines.
2. Send the invoice. **Expected:** the lines can no longer be edited.
3. **Add an expense**, then **Save budget** for the same category. **Expected:** the budget shows what is spent against it.
4. Browser A: Customers → open a won deal → **Make an invoice**. **Expected:** a draft invoice for that customer.

## 3. CSV in and out

1. Browser A: Customers → import a CSV with the columns `Name, Email, Company`. **Expected:** contacts appear and the companies they name are created.
2. Export contacts. Open the file. **Expected:** a cell beginning with `=` is exported with a leading `'` so a spreadsheet will not run it.
3. Settings → Audit log. **Expected:** the export is recorded.

## 4. AI apps: the owner's switch

1. Browser A: Settings → AI → "What AI apps may do here". **Expected:** it starts at off.
2. Choose read and write → **Save choice**.
3. Browser B: the same page shows the choice but cannot change it.

## 5. AI apps: a member connects one

Needs an AI app that supports remote MCP servers with sign-in. Point it at `http://localhost:3000/api/mcp`.

1. As the Sales member, start "connect" in the AI app. The browser opens Bizzy's consent screen.
2. "Which businesses may it reach?" → tick `Acme` → **Continue**.
3. In the AI app, list the tools. **Expected:** Tasks, Docs (read only) and Customers tools. **No Money tools.**
4. Ask it to create a task. **Expected:** the task appears in Browser B.
5. Ask it to list invoices. **Expected:** refused; Settings → Audit log (Browser A) shows the denial.

## 6. Revocation applies on the next call

1. Browser A: Settings → Members → set the Sales member to no role.
2. In the AI app, list tasks again, without reconnecting. **Expected:** refused.
3. Give the role back. Then Browser A: Settings → AI → "Apps connected right now" → disconnect the member's app. **Expected:** the next call is refused.
4. Browser B: "Your AI apps" (also under Your workspaces → Your AI apps) lists nothing.

## 7. API keys

1. Browser A: Settings → API → **Create a key** → name `Reporting script`, "Look only" → **Create key**. Copy the key; it is shown once.
2. Run:

   ```bash
   curl http://localhost:3000/api/v1/tasks -H "Authorization: Bearer <key>"
   ```

   **Expected:** JSON listing Acme's tasks. The exact paths are under "Technical details for developers" on the same page.
3. Try a write with the same key. **Expected:** refused (look only).
4. Revoke the key under "Keys in use". Repeat the first request. **Expected:** 401.

## 8. Webhooks

1. Browser A: Settings → Webhooks → **Add a webhook** → an `https://` address you control (a request-inspector site works) → choose "task created" → **Add webhook**. Copy the signing secret; it is shown once.
2. Create a task. **Expected:** "Messages sent lately" shows the delivery and its result, and the receiver got a JSON body with an `X-Bizzy-Signature` header.
3. Try adding a webhook to `https://127.0.0.1/x` or `http://example.com`. **Expected:** not delivered; private addresses and plain http are refused.

## 9. Files are checked against storage

1. Browser A: Docs → open a doc → **Upload a file**.
2. **Expected:** the size shown is the real size of the stored file. (The database copies it from storage; the test suite uploads with a false size and type to prove this.)
