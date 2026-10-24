---
name: Grailed
hosts: grailed.com
---
# Grailed

Public listings. Notes from hunts on 10-16 and 10-23.

## Search
- `www.grailed.com/shop?query=<query>` is the address the search box goes to; one script read 40 results off it. Once the same form answered "500 Internal Server Error" inside the page while `goto` reported success: `extract` and look before reading an empty page as no results.
- In a background tab the cards took over 10 s to draw on 10-23 (the page said "Loading"): give `wait` or `map` 30 s (`ms: 30000`) on selector `[class*=UserItem_root]` (a card). The count is in `[class*=Header_stats]` ("5 listings").
- Each result is a link to `/listings/<id>-<slug>`; `/listings/<id>` alone redirects there.
- Sold prices need a sign-in: the "Sold" filter opens an "Authentication" dialog (Log in, Continue with Google). Signed out, report sold comparisons as unavailable.

## Listings
- A listing page has no h1: wait on its text `"Seller Description"`, not a heading.
- The site's API (`/api/listings/<id>`) answered 429 to a script, and a plain HTTP read 403 (10-23): read the listing pages instead.
- Many listing pages: one `map` call with their addresses (up to 20, 6 at a time), never a `goto` loop with sleeps; a bash loop of goto, eval, and sleep took 2.5 s a listing.
- Full-size images: a photo address without its `?w=` query is the original (1800x2400 on 10-23).

## Readers
Shipped with the harness; run with `eval {tab, reader}` or `map {urls, what: "eval", reader}`.
- `search` on a /shop page: `heading` and `rows` (url, title, designer, size, price, age, full-size image).
- `listing` on a /listings/ page: title, designers, price, sold (with when and for how much), size, condition, description, seller, location, shipping, price drops, listed date, and full-size images.
