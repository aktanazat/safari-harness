---
name: Apple
hosts: reportaproblem.apple.com, account.apple.com, idmsa.apple.com
---
# Apple

Apple's account pages block page scripts, so `repl` evaluate fails with "security policy blocks eval". Read them with snapshot, extract, or data.

## Sign-in
- account.apple.com/sign-in shows no form to fill; do not wait for "Email or Phone" there.
- reportaproblem.apple.com sends a signed-out tab to idmsa.apple.com to sign in, then back.

## Refunds
- reportaproblem.apple.com: extract lists "Request a refund" and "Search by Price" once signed in.
