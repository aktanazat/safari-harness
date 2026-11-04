---
name: Duolingo
hosts: duolingo.com
---
# Duolingo

Password resets go by email; the web settings have no phone or authenticator two-factor.

## Password reset
- The FORGOT? link opens /forgot_password, which can bounce back to the home page within seconds; then refs go stale. Snapshot again before typing the email.
- The reset link arrives in Gmail within a minute and opens /reset_password.
- Its two fields ("New Password", "Confirm New Password") carry no autocomplete marks. If `passwords change` says "no new-password field", set `autocomplete="new-password"` on both with `eval`, then call it again. Done at "Password Changed!".
