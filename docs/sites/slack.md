---
name: Slack
hosts: slack.com, app.slack.com, www.slack.com
---
# Slack

A workspace host like `<workspace>.slack.com` matches this guide too.

Signed out, the global throws "not signed in to Slack in Safari". A workspace whose stored session has expired says it needs a fresh sign-in. Ask the user to sign in to Slack in Safari, then run it again.

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
