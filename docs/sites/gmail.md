---
name: Gmail
hosts: gmail.com, mail.google.com
---
# Gmail

## In safari repl

The `gmail` global reads mail through the signed-in Safari session, in a background tab of its own. `account` is the `/u/<n>/` index (from `googleAccounts.list()`) or the account's email; thread ids come from search results.

- `getInbox(account, {offset, limit})`: the inbox, newest first: id, from, subject, snippet, date, unread.
- `search(account, query, {offset, limit})`: threads matching a Gmail search (`from:`, `subject:`, `has:attachment`, `is:unread`, `newer_than:7d`); returns `{results, hasMore, total, nextOffset}`. `total` is null while Gmail still says "many".
- `getThread(account, threadId, {html})`: every message with from, to, cc, date, a plain-text body (`html: true` adds the HTML), and attachments `{name, id, size, url}`. Read from Gmail's print view, so the thread stays unread if it was.
- `downloadAttachment(account, url | {threadId, attachmentId}, {out})`: saves an attachment into `~/Downloads` (or at `out`) and returns the path.
- `openComposer({account, to, cc, bcc, subject, body})`: drafts only until approved; approved, it opens Gmail's compose window prefilled in a new tab for you. It never presses Send.
- `openReplyComposer(account, threadId, {body})`: drafts only until approved; approved, it opens the thread in a new tab, presses Reply, and types the body. It never presses Send, and opening the thread marks it read.

```js
const [{ index }] = await googleAccounts.list();
const { results } = await gmail.search(index, "has:attachment newer_than:7d", { limit: 5 });
const thread = await gmail.getThread(index, results[0].id);
console.log(thread.subject, thread.messages[0].body.slice(0, 200));
```

Each list page is one Gmail page load (about 1.5 s), so keep `limit` small. Gmail rewrites hex ids to a newer form once a thread is open in its UI; the ids `search` returns are the ones every method here takes.
