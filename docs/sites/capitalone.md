---
name: Capital One
hosts: capitalone.com, creditwise.capitalone.com
---
# Capital One and CreditWise

The user's Capital One accounts and CreditWise, its free credit report (TransUnion, with a FICO score). Read only.

## Signing in
- `open https://myaccounts.capitalone.com/accountSummary` goes to `verified.capitalone.com/auth/signin?...` when signed out: "Sign In", fields "Username" and "Password", "Remember Me", `Sign in`, and "Sign in using a passkey".
- `passwords` has one login for `verified.capitalone.com`. `fill` took about 17 s, Touch ID included. `Sign in` then lands on "Capital One | Account Summary".

## CreditWise
- On the account summary, the CreditWise tile's `Check your FICO® Score` opens a new tab, `https://creditwise.capitalone.com/summary?platform=easeweb`. It fills in late: `wait` for "FICO" or "Score".
- "Your TransUnion Credit Report" goes to `/report/credit-summary?platform=easeweb`; "Accounts & Balances" to `/report/balance-details?platform=easeweb`.
- On Accounts & Balances each account is a collapsed `mat-expansion-panel-header` (`aria-expanded`). Clicking every header at once left the fields empty. Open one at a time: click a header, wait for its panel to fill (about 2 s), then read that `mat-expansion-panel`. A panel lists status, date reported, payment status, credit limit, used percent, high balance, last payment, and age of account.
- A shell loop of `history` back and `sleep` between accounts returned partial data. Do the whole loop in one `repl` script or one `eval` in the CreditWise tab.
