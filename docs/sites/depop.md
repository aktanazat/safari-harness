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
- An item page is `www.depop.com/products/<slug>/`. `__NEXT_DATA__` is null there: the listing sits in the page's `self.__next_f.push(...)` script chunks (Next.js flight data). Joined, the object holding `"pictures":[` is the product (brand, description, sizes, seller, status), and the one holding `"totalCurrentPrice"` the price with `shippingCost`.
- From a www.depop.com tab, `fetch` of an item page's HTML returns the same chunks, so details for many items come from one `repl` script without opening a page each: about 1,400 listings ran at well under 1 s each on 10-16.
