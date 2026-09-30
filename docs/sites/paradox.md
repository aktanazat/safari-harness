---
name: Paradox
hosts: paradoxplaza.com, paradoxinteractive.com
---
# Paradox

Paradox Interactive accounts sign in on login.paradoxplaza.com; the login is saved under that host.

## Password reset
- accounts.paradoxplaza.com/reset-password emails a link to beta-accounts.paradoxinteractive.com/reset.
- Its field is named password and has no autocomplete mark: set `autocomplete="new-password"` with `eval` before `passwords change`.
- Pass site login.paradoxplaza.com to change. Without it the new password is saved under beta-accounts.paradoxinteractive.com and the real login keeps the old one.

## Deleting the account
- Only by a support.paradoxplaza.com ticket, "GDPR - Account Deletion", sent while signed in.
