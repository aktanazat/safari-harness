---
name: Paradox
hosts: paradoxplaza.com, paradoxinteractive.com
---
# Paradox

Paradox Interactive accounts sign in on login.paradoxplaza.com; the login is saved under that host.

## Password reset
- accounts.paradoxplaza.com/reset-password emails a link to beta-accounts.paradoxinteractive.com/reset.
- Its field is named password and has no autocomplete mark: set `autocomplete="new-password"` with `eval` before `passwords change`.
- Pass site login.paradoxplaza.com to change. The reset page is on another site, so without it change refuses, or updates an entry saved for beta-accounts.paradoxinteractive.com instead of the real login.

## Deleting the account
- Only by a support.paradoxplaza.com ticket, "GDPR - Account Deletion", sent while signed in.
