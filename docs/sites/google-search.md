---
name: Google Search
hosts: google.com, www.google.com
---
# Google Search

## In safari repl
The `googleSearch` global loads the results page in a background tab of its own and reads the organic results off it, so Google sees the owner's normal Safari session. It is a read; nothing is clicked or changed. Searches go out one at a time, at least three seconds apart, and a query that lands on Google's "unusual traffic" page throws an error naming that page: the owner passes the check in Safari, then the search is run again.

- `googleSearch.search(query, {limit, start})`: one page of organic results (`title`, `url`, `snippet`) plus `nextStart`, the `start` of the page after it when there is one; `start` is Google's page offset (0, 10, 20, ...), `limit` caps the results kept (default 10).

```js
const page = await googleSearch.search("safari web extension scripting api", { limit: 5 });
console.log(page.results.map((r) => `${r.title} — ${r.url}`).join("\n"));
const more = page.nextStart === undefined ? null : await googleSearch.search(page.query, { start: page.nextStart });
```
