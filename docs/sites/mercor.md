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
- The Okta step turns done only when Provision access is clicked again after the account is active: Mercor then reads the Okta user as active and moves to Payment setup.

## Tax form and payments
- The W-9 does not keep what was typed once the tab closes. Fill it in a tab the user will finish (keep), leave the SSN to him, and let him press "Agree and sign".
- Background check: "Start verification" with United States emails a Certn invite (no-reply@certn.co, "Background Screening Request From Mercor"); its apply link opens the Certn form.
- Payments: pick United States, then Stripe, then "Continue to Stripe". Stripe's email step needs real_input on Continue and may show an hCaptcha that clears itself, then texts a code (type with {{code}}). Stripe's form sits in a frame: click its buttons with real_input. A user with a Stripe Link account gets "Continue with Link", which pre-fills identity and payout bank; check the address there, it can be old. Stripe then asks for the full SSN, and "Agree and submit" warns that verification is still running; Submit anyway, and Mercor reads "Payments connected".
- ID verification is Persona: "Start verification" shows a QR code for the phone camera (App Clip, ID photo and selfie). Only the user can do it.
- The interview step ("Brief Introduction", about 4 minutes, camera and mic) can render blank on first load; reload it.

## Earnings
- The payment report is emailed, not downloaded: the page says "Payment Report request sent". Read it from the account's mail.
