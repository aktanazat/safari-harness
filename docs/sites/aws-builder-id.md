---
name: AWS Builder ID
hosts: signin.aws, events.builder.aws.com
---
# AWS Builder ID

AWS event pages (`events.builder.aws.com/<code>`) sign in with an AWS Builder ID. The link passes through Cvent's sign-in (`login.app.cvent.com/en-US/sign-on?transferId=...`, title "Login") and lands on `us-east-1.signin.aws/platform/<id>/login`, "Sign in with your AWS Builder ID".

## Signing in
- The page asks for the email first, then the password. "Continue with Google" on an email whose Builder ID uses a password ends at "This email is already associated with an AWS Builder ID using a different sign-in method", with a button back to the original method.
- A new browser is asked for a code after the password. The mail comes from `no-reply@login.awsapps.com` (not signin.aws), subject "Verify your identity": 6 digits, valid 10 minutes, a new one after 60 seconds. Type it with `secret: "page"` from the opened mail.

## Resetting the password
- "Forgot password?" switches the page to "Forgot password" / "Security check" at the same address: "Please click verify to start your security challenge", with Verify and Continue. Verify opens a captcha: hand it to the user with `handoff` and `until: "Check your inbox"`, since the address does not change.
- A check left open expires: the page then says "Something went wrong. It's not you, it's us." and "Invalid captcha". Open the event link again for a fresh check.
- The mail comes from `no-reply@signin.aws`, subject "Password reset requested", with a link to `/platform/<id>/resetpassword`. Open it in the same tab; its two password fields take the new password. A "Password updated" mail follows.

## Registering for an event
- After sign-in the Cvent form opens at `events.builder.aws.com/event/<id>/register`. First and last name can arrive filled with junk; replace them. Company Name is required, and Submit stays disabled until it is filled.
- Registered: the address ends in `/confirmation` and the page says "Your Confirmation Number is:". A "Registration Confirmed - <event>" mail from `no-reply@hub.awsevents.com` follows.
