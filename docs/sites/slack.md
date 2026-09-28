---
name: Slack
hosts: slack.com, app.slack.com, www.slack.com
---
# Slack

A workspace host like `<workspace>.slack.com` matches this guide too.

Signed out, the global throws "not signed in to Slack in Safari". A workspace whose stored session has expired says it needs a fresh sign-in. Ask the user to sign in to Slack in Safari, then run it again.

## Signing in with Google
- After the Google sign-in, the tab lands on `slack.com/signin?entry_point=redirect_flow#workspaces`: "Welcome back!", the Google account's email, and each workspace with its member count and an `Open` link.
- The workspace is not signed in yet at that point, and `slack.listWorkspaces()` does not list it. Click the workspace's `Open` link (a one-time `app.slack.com/t/<team>/login/...` address that opens in a new tab). The new tab reads "Launching ..." with a "use Slack in your browser" link; after it, `listWorkspaces()` shows the workspace. Close the new tab.
- In `safari repl`, catch that tab with `const [tab] = await Promise.all([page.waitForEvent("popup"), page.locator(ref).click()])`.
- The user's 99 Point workspace signs in with his 99point.co Google account.

## In safari repl
The `slack` global reads Slack through the session in Safari, from one background tab of its own; it boots the Slack client only when the stored workspaces are missing. Reading this way marks nothing as read.
- `slack.listWorkspaces()`: the workspaces signed in: team id, name, domain, url, your user id, and which was used last.
- `slack.getClient(teamId?)`: a client for one workspace (team id or domain; default: the last used). Keep it in a `const` for later calls.
- `client.conversations({types, limit, cursor})`: the channels, private channels, group and direct messages, with the cursor of the next page.
- `client.history(channel, {limit, oldest, latest, cursor})`: a channel's messages, newest first, with reactions, files, and thread counts.
- `client.replies(channel, ts, {limit, cursor})`: one thread.
- `client.search(query, {count, page})`: message search in Slack's own syntax (`from:@alice in:#general after:2026-01-01`).
- `client.users({limit, cursor})`, `client.userInfo(userId)`: the member directory.
- `client.api(method, params)`: any other web-API method that reads (`.list`, `.history`, `.replies`, `.info`, `.search`, `.get…`), answered as Slack answers it; methods that write are refused.
- `client.postMessage(channel, text, {thread_ts})`: drafts only until approved: returns the exact text and sends nothing; call it again with `approved: true` once the user has approved that text.

```js
const c = await slack.getClient();
const { channels } = await c.conversations({ types: "public_channel" });
const general = channels.find((ch) => ch.name === "general");
const { messages } = await c.history(general.id, { limit: 20 });
```
