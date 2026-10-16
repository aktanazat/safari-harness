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
- The first rows are "Shop on eBay" ads; keep rows that show "Sold <Mon> <day>".
- A search can come back as an error page: the title "Error Page | eBay" (`open` and `goto` then answer `ok: false` with a `warning`), or the text "SORRY Something went wrong on our end". An error page is not an empty search: check the title before reading no rows as none. On 10-16 the same search answered once loaded as `www.ebay.com/sch/i.html?_from=R40&_nkw=<query>&_sacat=0` (keep the other parameters); that worked once, so look at the title again.

## Items and orders
- Many item pages: one `map` call with their addresses and a wait on the item page's own text, such as `"Returns:"`, never a `goto` loop.
- The return policy is the "Returns:" row on the item page, for example "Seller does not accept returns".
- A sold item's page has a "See original listing" button that expands the listing in place.
- Purchases: www.ebay.com/mye/myebay/purchase. Open an order from its link there (order.ebay.com/ord/show?orderId=...).
- Typed /mys/purchase/orderdetails and /mys/review/returnstart links land on /mys/active; pages.ebay.com/mybids and /summy/order-history show "Error Page | eBay".
