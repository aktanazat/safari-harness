---
name: ETS
hosts: ets.org
---
# ETS

The ETS account behind test registration signs in on ereg.ets.org, but password resets run on idaas.ets.org.

## Password reset
- idaas.ets.org: Sign In > Forgot Password?, enter the username, then "Check Your Email". The link comes within about a minute as "ETS Password Reset Link" from IDaaS-noreply.
- The login is saved for ereg.ets.org, so call `passwords change` with site ereg.ets.org. Without it a new, wrong entry is made for idaas.ets.org.
