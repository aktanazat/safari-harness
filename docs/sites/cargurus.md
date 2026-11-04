---
name: CarGurus
hosts: cargurus.com
---
# CarGurus

Public car listings with CarGurus' price rating and each listing's price history. No sign-in needed.

## Search
- The rendered search page shows no VINs. Its data does: from the search tab, `fetch` the same search address with `&_data=routes%2F%28%24intl%29.search` added. The reply is `text/remix-deferred`; its first line is JSON, and `search.tiles[]` holds the results.
- Tiles whose `type` starts `LISTING_USED_` are cars (others, such as `MERCH_...`, are ads). Each tile's `data` has the listing id, `vin`, price, days on market, deal rating, the expected price (`imv`/`imvPrice`), options, colors, dealer, and location.

## A listing
- `https://www.cargurus.com/details/<listingId>`, titled "... - $<price> - CarGurus", with "N days on CarGurus".
- The price history is behind `Show full price history` (`button[aria-controls=priceHistoryTable]`); it is not a dialog, so `snapshot` with `root` `[role=dialog]` finds nothing. The table `#priceHistoryTable` comes a few seconds after the page.
- A click right after the page loaded did nothing. What worked: `wait` for "days on CarGurus", give the page about 3 s more, click the button, then `wait` for the selector `#priceHistoryTable tr`. Rows read "Date | Vehicle listed price".

## Research pages
- `/research/price-trends/<model>` addresses redirect when CarGurus has no page for that model (`/research/price-trends/BMW-2-Series-d2262` went to the M3's page). Check the `url` a `goto` returns before reading.
