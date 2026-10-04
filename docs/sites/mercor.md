---
name: Mercor
hosts: mercor.com
---
# Mercor

## Sign in
- work.mercor.com/login can stay blank (0 nodes, no requests) even after a reload. Open work.mercor.com/explore, click "Sign in", then "Google".
- Google opens in a popup tab (the click reports newTab); choose the account there, then go on in the first tab.

## Onboarding
- Phone number: type leaves the field at "+1 ". Use real_input: click the field, Cmd+A, type the digits, then press Tab so Continue enables.
- Date of birth: the calendar's year and month are selects (.rdp-years_dropdown, .rdp-months_dropdown) in the dialog. Set each with the native value setter and a bubbling change event, one eval per select.
- Country: clicking the combobox re-renders it under a new ref; snapshot before typing in it.

## Okta setup
- "Provision access" opens a c-mercor.okta.com reset-password tab. With an old Okta session in Safari it lands on /login/signout and shows "400 Bad Request" every time; run cookies clear on https://c-mercor.okta.com, then click Provision access again.
- The login is new to Apple Passwords: run passwords change with site c-mercor.okta.com and the account's email as username, then click Reset Password.
- "Set up security methods" is required next. "Security Key or Biometric Authenticator" makes a Touch ID passkey: click it, then hand off for Set up (only the user can approve). Done lands on /app/UserHome.
- Next on the Mercor Okta step then moves on, while the "7 of 14 steps" count stays as it was.

## Earnings
- The payment report is emailed, not downloaded: the page says "Payment Report request sent". Read it from the account's mail.
