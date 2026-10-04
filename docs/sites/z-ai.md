---
name: Z.ai
hosts: z.ai
---
# Z.ai

z.ai (plans, API keys) and chat.z.ai (the chat app) keep separate sessions; both sign in through chat.z.ai/auth.

## Sign in
- For plans and keys, open z.ai/subscribe and click Login: it goes through chat.z.ai/auth and Google and lands back on z.ai/subscribe signed in.
- Signing in on chat.z.ai alone can leave a guest session (an email like guest-…@guest.com). Read /api/v1/auths/ with the page's token to check which account it is.

## Pages
- Plan, credits, and API keys: z.ai/subscribe; the API Keys link is in its header once signed in.
