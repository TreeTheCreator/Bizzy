# Phase 3 demo script

> Every step here is also clicked through by the automated browser tests in `e2e/` (run with `npm run test:e2e`). Nobody has walked it by hand yet.

About 10 minutes. Use two browsers (or one normal and one private window): Browser A is the owner, Browser B a member.

**Setup:** `npm run db:start`, `npm run db:env`, `npm run dev`, open http://localhost:3000.

## 1. A business that starts with a kit

1. Browser A: Your businesses → enter `Corner Cafe` → "What kind of business is it?" = **Cafe or restaurant** → **Add business** (or **Get started** if it is your first).
2. Tasks. **Expected:** three setup tasks, "Projects (1)" and "Ready-made task lists (3)".
3. Docs. **Expected:** "Suppliers" and "How we open and close".

## 2. HR and pay

1. Browser A: HR → **Add a person** → `Ada Baker`, job `Head baker` → **Add person**.
2. On her row press **Pay** → `52000`, paid "a year" → **Save pay**. **Expected:** "$52,000.00 a year".
3. Time off → **Ask for time off** → Ada, five days → **Send request**. **Expected:** "Waiting for an answer". Press **Approve**.
4. Settings → Roles → create `HR clerk` with HR = "Can add and change", and leave "Private details" unticked. Invite a member and give them that role.
5. Browser B: HR. **Expected:** Ada and her job are shown; the page says your role does not include pay; there is no Pay column and no Pay button.
6. Browser B: Time off. **Expected:** the request is shown as Approved, with no Approve, Decline or Delete buttons.
7. Browser A: Settings → Activity log. **Expected:** an entry for the pay change, without the amount.

## 3. Reports

1. Browser A: Money → Expenses → add an expense in the category `Supplies`.
2. Reports → **Spending by category**. **Expected:** Supplies with the amount.
3. Switch the period to **This year**. **Save this report as** `Yearly spending` → **Save report**. **Expected:** it appears under "Saved reports".
4. **Download as spreadsheet**. **Expected:** a CSV file named after the report and its dates.
5. Browser B: Reports. **Expected:** only "Time off by person" (the HR clerk role includes HR and nothing else), and no saved Money report.

## 4. All businesses at a glance

1. Browser A: create a second business, then Your businesses → **At a glance**. **Expected:** a card per business with Tasks, Customers and Money figures, and a "Together" card adding them up.
2. Browser B: open `/overview`. **Expected:** "Nothing to show here yet": the HR clerk role does not include the Dashboard.
3. Browser A: Settings → Roles → give `HR clerk` Dashboard = "Can look" and Tasks = "Can look".
4. Browser B: refresh `/overview`. **Expected:** the one business they belong to, with Tasks figures only. No Customers or Money figures, and the owner's other business is not listed.
