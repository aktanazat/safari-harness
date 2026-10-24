---
name: Depop
hosts: depop.com
---
# Depop

Public listings; search and item pages read without signing in. Notes from one hunt on 10-16.

## Search
- The search page is `www.depop.com/search/?q=<query>&sort=newlyListed`. Its cards are `a[href*="/products/"]` links (skip `/products/create`); more load as the page scrolls.
- Faster than scrolling: the site's own search API, called from a tab on www.depop.com (`fetch` with `--tab`, or `fetch` inside `repl`): `https://www.depop.com/presentation/api/v1/search/products/?what=<query>&country=us&currency=USD&sort=newlyListed&items_per_page=24` answered 200 with `meta.total_count`, `page_info.has_more`, `page_info.last` (the next page's cursor), and `objects`, one per listing.
- The same path on `webapi.depop.com`, which the page itself calls, is refused from a script ("Load failed": its CORS rules), and so is `/api/v3/search/products/`. Use the www.depop.com path above.
- `ranking=recent&limit=24` in place of `sort=newlyListed&items_per_page=24` answered 403 with a "Just a moment" page: keep the parameters above.

## Items
- An item page is `www.depop.com/products/<slug>/`. Many of them: `map` with a wait on `{"text": "Buy now"}` or `{"selector": "script[type=\"application/ld+json\"]"}` (both 0.6-1.4 s on 10-23).
- `data` has the listing: `jsonld` the title, description, and `P0.jpg` images; `flight` (the Next.js `self.__next_f` stream; `__NEXT_DATA__` is null) the rest. `data {tab, pick: "flight..price[0]"}` is the price with `shippingCost` and `totalCurrentPrice`; `flight..pictures` the photos.
- Full-size images: the `P0.jpg` format of each picture (1280x1280 on 10-23).
- From a www.depop.com tab, `fetch` of an item page's HTML returns the same chunks, so details for many items come from one `repl` script without opening a page each: about 1,400 listings ran at well under 1 s each on 10-16.

## Readers
Shipped with the harness; run with `eval {tab, reader}` or `map {urls, what: "eval", reader}`.
- `item` on a /products/ page: title, brand, status, sizes, description, seller, location, price (with shipping, fees, total), and the P0.jpg images.
