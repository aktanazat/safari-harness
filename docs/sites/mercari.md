---
name: Mercari
hosts: mercari.com
---
# Mercari

Public listings. Notes from hunts on 10-16 and 10-23.

## Search
- `www.mercari.com/search/?keyword=<query>` is the search (the hunt's address added `&itemStatuses=1&sortBy=2`); its h1 holds the count ("oakley juliet (374 results)"). The results draw late: `wait` on the selector `a[href*="/item/m"]` (each card's link) before reading.
- The site's GraphQL API (`www.mercari.com/v1/api`, `operationName=searchFacetQuery`), called from a script without the page's own headers, answers HTTP 200 with `{"errors":[{"status":401,"message":"Unauthorized"}]}`. Read the search and item pages instead.

## Items
- An item page's address holds `/item/m` (the cards' links). Many of them: one `map` call with a wait on the item's own text, never a bash loop with sleeps; a loop with `sleep 5` a page took 6.6 s an item, most of it sleeping.
- The similar items under the listing repeat `[data-testid=ItemPrice]`: read the price inside `[data-testid=ItemInfo]`.
- Full-size images: an image address without its query is the original (1204x1600 on 10-23); `?width=` only scales it.

## Readers
Shipped with the harness; run with `eval {tab, reader}` or `map {urls, what: "eval", reader}`.
- `item` on an /item/ page: title, brand, price, availability, condition, category, posted, shipping, ships from, seller and reviews, description, and full-size images.
