---
name: Craigslist
hosts: craigslist.org
---
# Craigslist

Public listings. No sign-in needed.

## Search
- A regional address such as `sfbay.craigslist.org/search/cta?query=...&postal=<zip>&search_distance=600` redirects to `www.craigslist.org/search/city/<city>-<state>?cat=cta&query=...&postal=<zip>&radius=600`. Load the `www` form directly.
- `snapshot` of the results page showed only the search box. The results are `.cl-search-result` elements: `wait` for that selector (up to 20 s), then read each result's title, price, meta line, and link with one `eval`.
- A search by a model name also matches other models and dealer ads; filter the titles yourself.
