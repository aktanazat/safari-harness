---
name: eBay
hosts: ebay.com
error-titles: Error Page | eBay
---
# eBay

Plain `read` of signed-in eBay pages gets HTTP 403; use `open` or `map`.

## Sold prices
- Search sold items at www.ebay.com/sch/i.html?_nkw=<query>&LH_Sold=1&LH_Complete=1&_sop=13.
- Results render late: give `map` a wait on selector `ul.srp-results` or it returns no rows.
- Results are `ul.srp-results > li[data-listingid]`. "Shop on eBay" cards ($20.00 on 10-23) are ads that link to `/itm/123456`, not a listing: skip them. Keep rows that show "Sold <Mon> <day>".
- A heading "0 results for <query>" with "No exact matches found" is an empty search: the rows under it are other items, not matches.
- eBay drops a word it has no match for without saying so: on 10-23 "oakley juliet zzqxvbnmwq plasma" answered "1,000+ results for oakley juliet zzqxvbnmwq plasma", none with the made-up word. Check the titles hold the words before counting rows as matches.
- A search can come back as an error page: the title "Error Page | eBay" (`open` and `goto` then answer `ok: false` with a `warning`), or the text "SORRY Something went wrong on our end". An error page is not an empty search: check the title before reading no rows as none. On 10-16 the same search answered once loaded as `www.ebay.com/sch/i.html?_from=R40&_nkw=<query>&_sacat=0` (keep the other parameters); that worked once, so look at the title again. `map` loads an error page again 2 s and then 5 s later, and says `retried`.

## Items and orders
- Many item pages: one `map` call with their addresses and a wait on selector `[data-testid="x-price-primary"]` (the price), never a `goto` loop. A wait on the text "Returns:" missed after 10 s on 10-23.
- The return policy is the "Returns:" row on the item page, for example "Seller does not accept returns".
- A sold item's page has a "See original listing" button that expands the listing in place.
- Purchases: www.ebay.com/mye/myebay/purchase. Open an order from its link there (order.ebay.com/ord/show?orderId=...).
- Typed /mys/purchase/orderdetails and /mys/review/returnstart links land on /mys/active; pages.ebay.com/mybids and /summy/order-history show "Error Page | eBay".
- The seller's description is an iframe from itm.ebaydesc.com (`iframe#desc_ifr`); `fetch` of it from the item's tab fails ("Load failed"). `map` its address and read it with extract.
- Full-size images: `s-l1600` in place of the `s-l<n>` in an image address (1200x1600 on 10-23).

## Readers
Shipped with the harness; run with `eval {tab, reader}` or `map {urls, what: "eval", reader}`.
- `search` on a /sch/ page: `heading`, `exact` (false on an empty search: `rows` is then empty and `unrelated` counts the rows shown), and `rows` (id, url, title, price or "$a to $b" range, `bestOffer`, `bids` and `timeLeft` on auctions, condition, sold, shipping, location, seller, s-l1600 image), ads left out.
- `item` on an /itm/ page: title, price alone and `bestOffer` (the listing takes offers), status, seller, shipping, location, returns, item specifics, full-size images, and the description iframe's address.
