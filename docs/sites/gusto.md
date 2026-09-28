---
name: Gusto
hosts: gusto.com, app.gusto.com, login.gusto.com
---
# Gusto

This is the user's payroll: contractor payments, pay stubs, and the bank account pay goes to. Read only; never change a payment method or tax setting without the user's yes.

## Signing in
- `open https://app.gusto.com/` lands on `login.gusto.com/realms/zenpayroll/...`, titled "Gusto Login - Payroll, Benefits, HR | Gusto". The first page greets the user ("Good evening") with a button for his saved email, plus "Use another email".
- Clicking the email button goes to a password page ("Enter your password", a "Password" field, `Continue`) that also has a "Retry passkey" link.
- The passkey worked: `Retry passkey` with the tab in front, then the user touched Touch ID (about 20 s). Now click it and call `handoff` so he can touch the sensor.

## Finding pages
- Signed in, `https://app.gusto.com/` is "Home | Gusto", with links Home, My profile (`/profile`), Pay (`/pay`), Benefits, Documents, Help, Settings.
- Deep links from Gusto's emails do not route: `app.gusto.com/<company>/employee/profile/pay` showed the Home page. Click the `Pay` link instead; it goes to `/pay/payments`.
- `/profile` goes to `/profile/work`, with tabs Information, Work, Pay, Personal. `/profile/pay` shows the payment method (direct deposit, the bank connected with Plaid, a masked account) and `Compensation`.

## Payments
- `/pay/payments` fills in late: the first read showed only "Pay"; the list came about 12 s later. It reads "Contractor payments" with columns "Payday", "Payment method", "Status", "Total", "Actions".
- The page says "Payday". Gusto's email says "Paid on", and a `wait` for "Paid on" timed out. Wait for "Payday" or "Contractor payments".
- Each row's `More actions` button opens two menu items: "View" (`/contractor_payments/<id>.html?x_role_id=<id>`) and "Download PDF" (the same address ending `.pdf`). The View page shows the date, method, masked account, and invoice, and its own "Download PDF".
- `safari fetch` of the View address returns the page's HTML; from a shell, pipe `safari fetch --json` into the JSON parser.

## Page behavior
- One snapshot of the signed-in home page took 22 s. Read with `extract` and a `query`, or a `snapshot` `query`, rather than the whole page.
