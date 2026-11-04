---
name: ShopGoodwill
hosts: shopgoodwill.com
---
# ShopGoodwill

Public auctions; search and item pages read without signing in. Notes from one hunt on 10-23.

## Search
- Search with `https://shopgoodwill.com/categories/listing?st=<query>&s=&hp=999999&catIds=&p=1`; `&ps=40` and `p=2` page it. Every one of those parameters is needed: without `s` or `catIds` the page stays a skeleton, and without `hp` it ignores the query and lists all ~700,000 items.
- Wait on the text `"Showing "` ("Showing 1 to 40 of 50 entries"), not on the page loading.
- A page showing only "Filter Results", "CATEGORIES", and "PRICE" is the skeleton of a search that did not run, not an empty search: fix the address. An empty search says "Oops! We have a lot of items on ShopGoodwill.com but can't seem to find that one."
- Each card is `.feat-item`: `a.feat-item_name` (its id is the item id), `.feat-item_price`, and "Bids: N" and "Time remaining: …" in its text.

## Items
- An item page is `shopgoodwill.com/item/<id>`. Open each in a fresh tab (or `map`) and wait for `{"gone": "Please wait!"}`; a `goto` from a search tab stayed on "Please wait!".
- The site's API (`buyerapi.shopgoodwill.com/api/ItemDetail/GetItemDetailModelByItemId/<id>`, which the page calls) is refused to a script from the page's tab (CORS, "Load failed"): read the item pages.
- Full-size images: a list image address ends `_<date>t<k>.jpeg` (236x315); drop the `t` and make it `.jpg` (`…_1019t1.jpeg` → `…_10191.jpg`, 1280x960 on 10-23). Addresses in the page use backslashes: make them `/`.

## Readers
Shipped with the harness; run with `eval {tab, reader}` or `map {urls, what: "eval", reader}`.
- `search` on a listing page: `status` is `ready` or `empty`, `total` is
  zero only when the page explicitly reports no results, `showing` is
  the result count text when present, and `rows` contain valid item ids,
  urls, titles, prices, bids, time left, and full-size images. `skipped`
  counts unreadable cards. A page still loading or whose count and cards
  disagree fails instead of returning an empty result or an invalid url.
- `item` on an /item/ page: title, price, minimum bid, bids, time left, end time, shipping, handling, seller, description, and full-size images.
