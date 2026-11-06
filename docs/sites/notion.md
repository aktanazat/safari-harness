---
name: Notion
hosts: notion.so, www.notion.so, notion.site, notion.com, www.notion.com
---
# Notion

The web app lives at `app.notion.com`. Signed out, the global throws "not signed in to Notion in Safari". Ask the user to sign in there, then run it again.

## Signing in
- Google sign-in opens a popup with Google's account chooser; the popup closes itself after the user consents, and the tab signs in. In `safari repl`, catch it with `page.waitForEvent("popup")`.
- Pick the right Google account. The user's Notion workspace (SacHacks) belongs to his ucdavis.edu Google account. Picking his 99point.co account created a new, empty Notion account ("How do you want to use Notion?" at `app.notion.com/onboarding`, and `notion.listAccounts()` showed no spaces).
- Notion's email does not point to the right account: its mail sat in his gmail.com inbox. Ask him, or check his notes (`mem-find "notion account"`), before choosing.
- To switch accounts, load `https://www.notion.so/logout` in your tab, then sign in again and choose the other account.

## In safari repl
The `notion` global reads Notion through the session in Safari, from one background tab of its own. Nothing in it writes.
- `notion.listAccounts()`: the accounts signed in, each with its user id, name, email, and spaces.
- `notion.getClient(userId?)`: a client for one account (user id or email; default: the first). Keep it in a `const` for later calls.
- `client.search(query, {limit, spaceId})`: pages and databases matching the query, in all of the account's spaces or in one.
- `client.recent({since, limit, spaceId})`: pages edited after `since` (a date, an ISO time, or ms; default a day ago), newest first: `{pages, hasMore}`, up to `limit` pages (default 50, at most 500). Each page has the fields of a search hit, `lastEditedTime` among them. `hasMore: true` means more pages were edited than `limit`: raise it or move `since` later. Use it for "what changed since yesterday", not a loop of `search()` calls.
- `client.getPage(pageId)`: a page's title, properties (by name, for database rows; people by name), parent, and child block ids. A share link, a 32-character id, or a uuid all work as the id. On a database page it gives no title and no rows: `queryDatabase` gives its `name` and rows.
- `client.queryDatabase(databaseId, {limit})`: a database's rows: `{id, name, rows, hasMore}`. Each row is `{id, title, properties, createdTime, lastEditedTime, url}`, with `properties` by column name as text (status and select as the option, people by name, dates as `2026-01-31` or `start → end`). It reads every row, whatever the view's filter, up to `limit` (default 100, at most 500); `hasMore: true` means more rows than that. The id is the database page's or an inline database block's; a row is a page, so `blockToMarkdown(row.id)` reads its body.
- `client.getBlock(blockId)`: one block: type, text, children.
- `client.blockToMarkdown(blockId, {maxBlocks})`: the page or block and everything under it as Markdown (headings, lists, to-dos, quotes, code, tables, links to child pages), stopping at `maxBlocks` (default 500). An inline database shows as `(database: name, id)`, no rows; pass that id to `queryDatabase`.

```js
const n = await notion.getClient();
const [hit] = await n.search("roadmap", { limit: 5 });
console.log(await n.blockToMarkdown(hit.id));
const { pages, hasMore } = await n.recent({ since: new Date(Date.now() - 86_400_000) });
const { rows } = await n.queryDatabase("https://www.notion.so/Tasks-0123456789abcdef0123456789abcdef");
console.log(rows.filter((r) => r.properties.Status !== "Done"));
```
