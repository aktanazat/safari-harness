---
name: X
hosts: x.com, twitter.com, www.x.com, mobile.twitter.com
---
# X

Signed out, the global throws "not signed in to x.com in Safari". If Safari is on the wrong account, the user switches accounts from the account menu at the bottom of the left column on `x.com/home` instead of signing out.

## Accounts
- The account menu's "Log out @<handle>" names the signed-in account.
- "Add an existing account" goes to /i/jf/onboarding/web?mode=login, which shows a choice of sign-in options before any username field. Snapshot it before you wait for a field.

## In safari repl
The `x` global (also `twitter`) reads X through the session in Safari, from one background tab of its own, the way the X web app does. Reading marks nothing seen: notifications and messages keep their unread state.
- `x.getMe()`: the signed-in account: id, handle, name, bio, follower and following counts.
- `x.getUser(handle)`: one account by handle (or profile url).
- `x.getTweet(idOrUrl)`: one post: text, author, counts, views, and what it replies to or quotes.
- `x.getTimeline({count, cursor})`: the Following feed, newest first, with the cursor of the next page.
- `x.search(query, {count, cursor, product})`: search in X's own syntax (`from:alice since:2026-01-01`); product is `Latest` (default), `Top`, `People`, `Photos`, or `Videos`. `People` answers in `users`.
- `x.getUserTweets(handle, {count, cursor})`: an account's posts.
- `x.getBookmarks({count, cursor})`: the bookmarks.
- `x.getDmInbox()`: the message inbox: each conversation with its participants, unread flag, and last message.
- `x.getNotifications({count, cursor})`: recent notifications: kind, who, text, and the post concerned.
- `x.post(text, {replyTo})`, `x.like(idOrUrl)`, `x.follow(handle)`, `x.sendDm(conversationOrHandle, text)`: drafts only until approved: each returns the exact action and sends nothing; call it again with `approved: true` once the user has approved that text.

```js
const { tweets, nextCursor } = await x.search("from:X", { count: 10, product: "Latest" });
tweets.map((t) => `${t.author.handle}: ${t.text.slice(0, 80)}`);
```
