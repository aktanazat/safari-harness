---
name: Garmin
hosts: garmin.com
---
# Garmin

Sign-in runs on sso.garmin.com for connect.garmin.com and the store.

## Password reset
- Forgot Password emails an 8-character temporary password in the body of "Password Reset - Just a Few Easy Steps", not a link. `{{code}}` refuses it because the mail shows more than one code. Enter it unseen from a script: `eval` reads it from the email tab and `type` with secret true fills the sso sign-in.
- After signing in with it, Change Password has no current-password field, so `passwords change` fills it.
- An email security code follows at "Enter security code". Click Next; Enter puts the code in the address bar.
