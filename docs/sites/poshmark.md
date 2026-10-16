---
name: Poshmark
hosts: poshmark.com
---
# Poshmark

Public listings. Notes from one hunt on 10-16.

## Search
- `poshmark.com/search?query=<query>&department=Men&type=listings&sort_by=added_desc` lists the newest first; `&max_id=2` is the second page.
- The results are in the page's `window.__INITIAL_STATE__`. Read them with `data`, not the page text: `data {tab, pick: "state.$_search.gridData.data"}` (CLI `safari data --tab N --pick 'state.$_search.gridData.data'`) is the listings; `gridData.more` and `gridData.total_listing_count` say whether there is more. The whole `gridData` is about 1 MB, so pick into it.
- A script calling the site's own posts API failed with "The string did not match the expected pattern." (10-16), Safari's error for a request or parse that went wrong; the `data` path above worked.

## Listings
- A listing is `poshmark.com/listing/<title>-<id>`. Many of them: one `map` call, not a goto loop.
