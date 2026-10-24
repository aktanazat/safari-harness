---
name: Poshmark
hosts: poshmark.com
---
# Poshmark

Public listings. Notes from hunts on 10-16 and 10-23.

## Search
- `poshmark.com/search?query=<query>&department=Men&type=listings&sort_by=added_desc` lists the newest first; `&max_id=2` is the second page.
- The results are in the page's `window.__INITIAL_STATE__`. Read them with `data`, not the page text: `data {tab, pick: "state.$_search.gridData.data"}` (CLI `safari data --tab N --pick 'state.$_search.gridData.data'`) is the listings; `gridData.more` and `gridData.total_listing_count` say whether there is more. The whole `gridData` is about 1 MB, so pick into it.
- A script calling the site's own posts API failed with "The string did not match the expected pattern." (10-16), Safari's error for a request or parse that went wrong; the `data` path above worked.

## Listings
- A listing is `poshmark.com/listing/<title>-<id>`; `/listing/<id>` alone redirects there. Many of them: one `map` call, not a goto loop.
- Full-size images: the `url_large` picture, `l_` in the file name (1000x1333 on 10-23); `m_` is 550 wide.

## Readers
Shipped with the harness; they read `__INITIAL_STATE__`, so they run in the page's world by themselves. Run with `eval {tab, reader}` or `map {urls, what: "eval", reader}`.
- `search` on a search page: `total`, `more`, and `rows` (id, url, title, brand, price, original price, size, status, seller, listed, large image).
- `listing` on a /listing/ page: title, brand, price, original price, size, status, description, seller, listed, likes, and large images.
