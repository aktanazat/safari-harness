---
name: Gmail
hosts: gmail.com, mail.google.com
---
# Gmail

Signed out, or on an account Gmail wants to re-check, the global throws "not signed in to Gmail in Safari". Ask the user to open Gmail in Safari and sign in, then run it again.

## In safari repl

The `gmail` global reads mail through the signed-in Safari session, in a background tab of its own. `account` is the `/u/<n>/` index (from `googleAccounts.list()`) or the account's email: 0 is aktanaazat@gmail.com, 1 aktan@99point.co, 2 aazat@ucdavis.edu. Thread ids come from search results.

Do Gmail work in one named session, `safari repl --session <name>`: its tab and variables last from one script to the next, so keep the threads you read in variables and filter and slice inside the script, printing only what you need. A call waits at most 120 s for its script; split longer loops across calls.

- `getInbox(account, {offset, limit})`: the inbox, newest first, in the shape `search` returns.
- `search(account, query, {offset, limit})`: threads matching a Gmail search (`from:`, `subject:`, `has:attachment`, `is:unread`, `newer_than:7d`). Returns `{results, hasMore, total, nextOffset}`; `total` is null while Gmail still says "many". Each result is `{id, threadId, from, fromEmail, senders, subject, snippet, date, unread}`: `from` holds the senders' names, `fromEmail` their addresses, and `senders` both, as `[{name, email}]`.
- `getThread(account, threadId, {html})`: `{id, threadId, subject, messages, attachments}`. A message is `{from, to, cc, replyTo?, date, body, attachments}`: `from` is `{name, email}`, `to` and `cc` are lists of them, `body` is plain text, and `bodyHtml` comes only with `html: true`. An attachment is `{name, id, size, url}`; the thread's own `attachments` lists every message's, each with `message`, its index in `messages`. A message whose body is only `[Quoted text hidden]` (the newest can be) has `quotedOnly: true`: its words are in the messages before it. Read from Gmail's print view, so the thread stays unread if it was.
- `downloadAttachment(account, url | {threadId, attachmentId}, {out})`: saves an attachment, or an inline image by its `src` in `bodyHtml`, into `~/Downloads` (or at `out`) and returns the path. Give a file you only read an `out` in a temporary folder. A `fetch` of a `view=att` address is refused by Gmail's page rules; this method gets the file.
- `openComposer({account, to, cc, bcc, subject, body})`: drafts only until approved; approved, it opens Gmail's compose window prefilled in a new tab for you. It never presses Send.
- `openReplyComposer(account, threadId, {body})`: drafts only until approved; approved, it opens the thread in a new tab, presses Reply, and types the body. It never presses Send, and opening the thread marks it read.

```js
const [{ index }] = await googleAccounts.list();
const { results } = await gmail.search(index, "has:attachment newer_than:7d", { limit: 5 });
const thread = await gmail.getThread(index, results[0].id);
console.log(thread.subject, thread.attachments.map((a) => `${a.message}: ${a.name}`), thread.messages.at(-1).body.slice(0, 200));
```

To save a thread as a PDF, open its print view and print that: `const p = await openTab("https://mail.google.com/mail/u/<n>/?view=pt&search=all&th=<id>"); await p.pdf({ path: "/tmp/thread.pdf" })`.

Each list page is one Gmail page load (about 1.5 s), so keep `limit` small. Gmail rewrites hex ids to a newer form once a thread is open in its UI; the ids `search` returns are the ones every method here takes.

## In the Gmail page

- Wait for text (`wait` with `text`), not `quiet`: Gmail's long-polls keep the page busy, so it never goes quiet.
- In the thread list a row's ref is its checkbox; open a message by clicking its subject text.
- The filter list in Settings lags behind a filter just made, so a filter missing from it right after you made it is not proof it failed.
