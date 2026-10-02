---
name: TikTok
hosts: tiktok.com
real-input: true
---
# TikTok

TikTok tells scripted clicks from real ones. This guide marks tiktok.com for real input, so a model's `click` and `type` with a ref there go as `real_input` from the start.

## Signing up and signing in
- On 10-01 and 10-02 the sign-up answered every scripted Next with "Maximum number of attempts reached. Try again later." A new email address, cleared cookies and storage, and another network exit changed nothing. The same step with real input went through at once.
- Each refused try may count against that limit, so a scripted retry makes it worse. Send the step once with real input.
- "Continue with Google" opens Google's sign-in in a new window. A passkey or Touch ID prompt there is the user's to clear: use `handoff`.
