---
name: Shopify checkout
hosts: shop.app, worldcondoms.com
---
# Shopify checkout

Shopify stores (worldcondoms.com among them) share one checkout. Seen on
10-05 while reordering from WorldCondoms.

## Cart
- The store's own `/cart/add.js` (POST `{items: [{id, quantity}]}`) and
  `/cart.js` work from `page.evaluate` in `repl`; variant ids come from
  `/products/<handle>.js`. Read `/cart.js` first and leave a cart he
  already filled alone.

## Checkout
- `/checkout` lands on `/checkouts/cn/<token>/…`. About a minute later,
  once the tab came to the front, it moved on its own to
  `shop.app/checkout/…/shoppay`, Shop Pay's sign-in. Its guest-checkout
  link returns to the store's checkout with `skip_shop_pay=true`.
- Pay now with Apple Pay chosen: press it with `real_input`, then
  `handoff` (the reference's Payment cards). It lands on
  `/checkouts/cn/<token>/thank-you` with a confirmation number.
