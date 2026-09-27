---
name: Notion
hosts: notion.so, www.notion.so, notion.site, notion.com, www.notion.com
---
# Notion

The web app lives at `app.notion.com`. Signed out, the global throws "not signed in to Notion in Safari". Ask the user to sign in there, then run it again.

## In safari repl
The `notion` global reads Notion through the session in Safari, from one background tab of its own. Nothing in it writes.
- `notion.listAccounts()`: the accounts signed in, each with its user id, name, email, and spaces.
- `notion.getClient(userId?)`: a client for one account (user id or email; default: the first). Keep it in a `const` for later calls.
- `client.search(query, {limit, spaceId})`: pages and databases matching the query, in all of the account's spaces or in one.
- `client.getPage(pageId)`: a page's title, properties (by name, for database rows), parent, and child block ids. A share link, a 32-character id, or a uuid all work as the id.
- `client.getBlock(blockId)`: one block: type, text, children.
- `client.blockToMarkdown(blockId, {maxBlocks})`: the page or block and everything under it as Markdown (headings, lists, to-dos, quotes, code, tables, links to child pages), stopping at `maxBlocks` (default 500).

```js
const n = await notion.getClient();
const [hit] = await n.search("roadmap", { limit: 5 });
console.log(await n.blockToMarkdown(hit.id));
```
