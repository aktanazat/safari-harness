---
name: Mercari
hosts: mercari.com
---
# Mercari

Public listings. Notes from one hunt on 10-16.

## Search
- `www.mercari.com/search/?keyword=<query>` is the search (the hunt's address added `&itemStatuses=1&sortBy=2`). The results draw late: `wait` on the selector `a[href*="/item/m"]` (each card's link) before reading.
- The site's GraphQL API (`www.mercari.com/v1/api`, `operationName=searchFacetQuery`), called from a script without the page's own headers, answers HTTP 200 with `{"errors":[{"status":401,"message":"Unauthorized"}]}`. Read the search and item pages instead.

## Items
- An item page's address holds `/item/m` (the cards' links). Many of them: one `map` call with a wait on the item's own text, never a bash loop with sleeps; a loop with `sleep 5` a page took 6.6 s an item, most of it sleeping.
