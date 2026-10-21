---
name: Grailed
hosts: grailed.com
---
# Grailed

Public listings. Notes from one hunt on 10-16.

## Search
- `www.grailed.com/shop?query=<query>` is the address the search box goes to; one script read 40 results off it. Once the same form answered "500 Internal Server Error" inside the page while `goto` reported success: `extract` and look before reading an empty page as no results.
- Each result is a link to `/listings/<id>-<slug>`.

## Listings
- The site's API (`/api/listings/<id>`) answered 429 to a script: read the listing pages instead.
- Many listing pages: one `map` call with their addresses (up to 20, 6 at a time), never a `goto` loop with sleeps; a bash loop of goto, eval, and sleep took 2.5 s a listing.
