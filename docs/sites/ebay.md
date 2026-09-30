---
name: eBay
hosts: ebay.com
---
# eBay

Plain `read` of signed-in eBay pages gets HTTP 403; use `open` or `map`.

## Sold prices
- Search sold items at www.ebay.com/sch/i.html?_nkw=<query>&LH_Sold=1&LH_Complete=1&_sop=13.
- Results render late: give `map` a wait on selector `ul.srp-results` or it returns no rows.
- The first rows are "Shop on eBay" ads; keep rows that show "Sold <Mon> <day>".

## Items and orders
- The return policy is the "Returns:" row on the item page, for example "Seller does not accept returns".
- A sold item's page has a "See original listing" button that expands the listing in place.
- Purchases: www.ebay.com/mye/myebay/purchase. Open an order from its link there (order.ebay.com/ord/show?orderId=...).
- Typed /mys/purchase/orderdetails and /mys/review/returnstart links land on /mys/active; pages.ebay.com/mybids and /summy/order-history show "Error Page | eBay".
