# Phase 2 demo script

> Most of this was walked in a browser against the local stack on Nov 15, 2026. **Not walked:** section 5 (connecting a real AI app, which needs the deployed site because AI apps connect to a public https address), budgets (section 2, step 4), importing contacts (section 3, step 2), section 6, a real webhook delivery (section 8, step 2) and section 9.

About 15 minutes. Use two browsers (or one normal and one private window). It continues from the [Phase 1 demo](DEMO-phase-1.md): an `Acme` workspace with an owner (Browser A) and a second member (Browser B).

**Setup:** `npm run db:start`, `npm run db:env`, `npm run dev`, open http://localhost:3000. `npm run db:env` writes the local keys that switch on the API and webhooks.

## 1. Customers follow the role

1. Browser A: Settings → Roles → create a role `Sales` with Tasks = "Can add and change", Customers = "Can add and change", everything else "Can't open it".
2. Settings → People → set the member's role to `Sales`. **Expected:** the drop-down keeps showing `Sales`.
3. Browser B: refresh. **Expected:** the sidebar shows Home, Tasks, Customers and Alerts. No Docs, Money or Settings.
4. Browser B: Customers → Companies → **New company**; Contacts → **New contact**; Deals → **New deal**. Move the deal along the stages with the drop-down on its card.
5. Browser B: open the deal. **Expected:** only **Save changes**. No "Delete deal" (needs "Can also delete") and no "Make an invoice from this deal" (needs Money).
6. Browser B: type `/w/<id>/finance` in the address bar. **Expected:** "You can't open this page".

## 2. Money

1. Browser A: Customers → open a deal in the Won stage → **Make an invoice from this deal**. **Expected:** a draft invoice for that customer, with the deal as its first item.
2. Add a second item. **Expected:** the total equals the items.
3. Set Status to "Sent" → **Save changes**. **Expected:** the items can no longer be changed; the page says to set the status back to "Draft" first.
4. Money → Expenses → **Add expense**. Then Budgets → **Save budget** for the same category. **Expected:** the budget shows what is spent against it.

The four figures at the top of Money are rounded to whole amounts.

## 3. Spreadsheets in and out

1. Browser A: Money → Expenses → "Bring in expenses from a spreadsheet" → choose a CSV file whose top row is `Date,Category,Vendor,Amount,Notes` → **Bring in**. **Expected:** "Imported N expenses."
2. Customers → Contacts has the same for contacts; companies named in the file are created.
3. **Download as spreadsheet** on any list. **Expected:** a cell beginning with `=` is written with a leading `'` so a spreadsheet will not run it.
4. Settings → Activity log. **Expected:** each download is recorded as "Data export".

## 4. AI apps: the owner's switch

1. Browser A: Settings → AI apps → "What AI apps may do here". **Expected:** it starts at "Nothing".
2. Choose "Look and make changes" → **Save choice**. **Expected:** "Saved."
3. A member who is not the owner can see the choice but cannot change it.

## 5. AI apps: a member connects one (not yet walked)

Needs the deployed site and an AI app that supports remote MCP servers with sign-in. Point it at `https://<your site>/api/mcp`.

1. As the Sales member, start "connect" in the AI app. The browser opens Bizzy's consent screen.
2. "Which businesses may it reach?" → tick `Acme` → **Continue**.
3. In the AI app, list the tools. **Expected:** Tasks and Customers tools. **No Money tools.**
4. Ask it to create a task. **Expected:** the task appears in Browser B.
5. Ask it to list invoices. **Expected:** refused; Settings → Activity log (Browser A) shows the denial.
6. Browser A: Settings → People → set the member to "No role (sees nothing)". Ask the AI app to list tasks again, without reconnecting. **Expected:** refused.
7. Give the role back. Browser A: Settings → AI apps → "Apps connected right now" → disconnect the member's app. **Expected:** the next call is refused, and the member's "Your AI apps" page lists nothing.

## 6. Revocation in the web app

1. Browser A: Settings → People → set the member to "No role (sees nothing)".
2. Browser B: refresh. **Expected:** "You're in, but can't see anything yet".

## 7. API keys

1. Browser A: Settings → API keys → name `Reporting script`, "Look only" → **Create key**. Copy the key; it is shown once.
2. Run:

   ```bash
   curl http://localhost:3000/api/v1/tasks -H "Authorization: Bearer <key>"
   ```

   **Expected:** JSON with the workspace's tasks. More examples are under "Technical details for developers" on the same page.
3. Try to create a task with the same key (`POST /api/v1/tasks`). **Expected:** 403, permission denied.
4. Under "Keys in use" press **Switch off** and confirm. Repeat the first request. **Expected:** 401.

## 8. Webhooks

1. Browser A: Settings → Webhooks → enter an `https://` address you control (a request-inspector site works) → tick "Task created" → **Add webhook**. Copy the signing secret; it is shown once.
2. Create a task. **Expected:** "Messages sent lately" shows the message and its result, and the receiver got a JSON body with an `X-Bizzy-Signature` header.
3. Try adding `https://127.0.0.1/hook` or `http://example.com/hook`. **Expected:** refused when you add it. (An address that only turns out to be private after it is looked up is refused when the message is sent, and shows as "Having trouble, retrying".)

## 9. Files are checked against storage

1. Browser A: Docs → open a doc → **Upload a file**.
2. **Expected:** the size shown is the real size of the stored file. (The database copies it from storage; the test suite uploads with a false size and type to prove this.)
