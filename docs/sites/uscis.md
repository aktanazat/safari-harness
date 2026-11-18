---
name: USCIS online account
hosts: myaccount.uscis.gov, my.uscis.gov
---
# USCIS online account

## Signing in
- `myaccount.uscis.gov/sign-in` takes the email and password (Apple Passwords fills both); Sign In stays disabled for a moment after the fill.
- Next comes "Verification Code". The mail comes from `MyAccount@uscis.dhs.gov` (not uscis.gov), subject "Secure two-step verification notification". Type it with `type {text: "{{code}}", secret: "mail", sender: "uscis.dhs.gov"}`: without sender the code is passed over as another domain's (11-16). "please request a new verification code." sends another.
- A "Register Passkey" panel follows the code; Skip goes on to the dashboard.

## Cases and the annual asylum fee
- The dashboard's "Go to myUSCIS" button opens `my.uscis.gov/account/applicant`: each case with its receipt number, status, and a Case History tab.
- The annual asylum fee starts at `my.uscis.gov/accounts/annual-asylum-fee/start/overview`. Next asks for the A-Number and the receipt number, then "Continue to payment" goes to Pay.gov.
