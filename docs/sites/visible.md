---
name: Visible
hosts: visible.com
---
# Visible

The account is at www.visible.com/account. /account/login redirects to /sign-in ("Member Sign-In | Visible"), which loads slowly behind a spinner; wait for the email field before `passwords fill`.

## Sign-in
- A code is sent after the email step. Type it with `type` and text `{{code}}`.
- Waits for "Plan" match the menu and "We sent your code" is gone at once, so neither shows sign-in finished. Go to /account and wait for "Your plan"; it took about 15 s.
