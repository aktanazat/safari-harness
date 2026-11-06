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
- `client.conversations({types, limit, cursor})`: the channels, private channels, group and direct messages: `{channels, nextCursor}`. A page can come back with fewer channels than `limit`, even none, and still carry a `nextCursor`; only `nextCursor: null` means the last page.
- `client.history(channel, {limit, oldest, latest, cursor})`: a channel's messages, newest first, with reactions, files, and thread counts: `{messages, hasMore, nextCursor}`. Each file is `{id, name, type, size, url}`.
- `client.replies(channel, ts, {limit, cursor})`: one thread: `{messages, hasMore, nextCursor}`.
- `client.search(query, {count, page})`: message search in Slack's own syntax (`from:@alice in:#general after:2026-01-01`): `{total, page, pages, matches}`. Each match carries `ts` and `text`, and when Slack gives them, `channel` (the id), `channelName`, `user` (or `username` for a bot), and `permalink`. Pass the next `page` for more.
- `client.users({limit, cursor})`, `client.userInfo(userId)`: the member directory; `users` answers `{members, nextCursor}`.
- Paging: the field is `nextCursor` (camelCase, not Slack's `next_cursor`), and `null` on the last page. Pass it back as `cursor` until it is `null`:
  `let all = [], cursor; do { const p = await c.conversations({ cursor }); all.push(...p.channels); cursor = p.nextCursor; } while (cursor);`
- `client.download(file, out)`: saves a message's file at `out` (a relative path begins in the session's folder, `pwd`) and returns `{path, size, type}`. `file` is one that `history` or `replies` listed, which carries its address, or a file id (`F…`), which costs a `files.info` call first. The bytes come from files.slack.com through the global's own tab, so no tab of yours is needed. Slack's sign-in page in place of the file fails, and nothing is saved. A `429` (too many requests) is waited out as Slack says, or 5 s and then 10 s when it does not, by every session's calls to that host; a third 429 fails with `rate_limited`. `safari download` of a files.slack.com address without a signed-in tab gets the sign-in page and fails.
- `client.api(method, params)`: any other web-API method that reads (`.list`, `.history`, `.replies`, `.info`, `.search`, `.get…`), answered as Slack answers it; methods that write are refused.
- `client.scan(channel, {limit, match, threads})`: the latest messages with each thread's replies after their parent, kept when `match` (a RegExp, or text matched case-insensitively) is in the text. One call for a history loop plus a `replies` call per thread; `threads: false` skips the replies.
- `client.messageAt(channel, ts, {thread_ts})`: one message. A thread reply is not in its channel's history; pass its thread's ts as `thread_ts`.

### Writing as the owner
Every write drafts first: without `approved` it returns `{status: "draft", draftId, action, from, to, text}` and changes nothing; `from` names the workspace and user it goes out as. Show the owner that exact draft; only after he approves it, call again in a later call with the same arguments and `approved: "<draftId>"`. A draft sends once, within 30 minutes, from the REPL session that made it; `approved: true`, another draft's id, changed arguments, a reused id, or an id from the same run are refused and send nothing. A sent write returns `{status: "sent", draftId, result}`; the new message's ts is `result.ts`, not a top-level `ts`. A write whose tab closed while its request was out fails with `effect_unknown` and is not sent again: check Slack before drafting it again.
- `client.postMessage(channel, text, {thread_ts})`: one message, or a reply when `thread_ts` is given.
- `client.postThread(channel, text, replies)`: a top message and its thread replies as one approval, each reply posted under the top message's ts. `result` is `{ts, channel, replies: [ts…]}`. Use it for "summary on top, details in the thread" updates instead of chaining `postMessage` calls. When a reply fails after the top message went out, the error names the top message's ts and how many replies were posted. Call `postThread` again with the same texts: its new draft says which replies are left, and approved it posts only those under the same top message (`result.resumed: true`), never the top message again.
- `client.update(channel, ts, text, {thread_ts})`: edits a message the owner wrote. The draft adds `was`, the text it replaces. Slack refuses others' messages (`cant_update_message`).
- `client.delete(channel, ts, {thread_ts})`: deletes a message the owner wrote, and refuses anyone else's (an admin's delete of a member's message is permanent). The draft's `text` is the message that would go; a thread's replies stay when its parent goes.
- `client.react(channel, ts, name, {thread_ts})`: adds an emoji reaction (`name` with or without colons). The draft shows the message it goes on.
- `client.upload(channel, path, {thread_ts, title, comment})`: shares a local file (a relative path begins in the session's folder) in a channel or thread through Slack's external upload, with no file dialog. `result` is `{file, channel, permalink}`.
- `client.deleteFile(fileId)`: deletes a file the owner uploaded (`F…`), and refuses anyone else's. Deleting the message that carried a file leaves the file in his files; this removes it.

```js
const c = await slack.getClient();
const { channels } = await c.conversations({ types: "public_channel" });
const general = channels.find((ch) => ch.name === "general");
const { messages } = await c.history(general.id, { limit: 20 });
const [file] = messages.flatMap((m) => m.files ?? []);
if (file) console.log(await c.download(file, file.name)); // {path, size, type}
```
