const text = (id) => ((document.querySelector(`[data-testid=ItemInfo] [data-testid="${id}"]`) ?? document.querySelector(`[data-testid="${id}"]`))?.innerText ?? "").replace(/\s+/g, " ").trim();
const ld = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent);
({
  id: ld.productID ?? /\/item\/(m\d+)/.exec(location.pathname)?.[1],
  url: ld.offers?.url ?? location.href,
  title: ld.name,
  brand: ld.brand?.name,
  price: text("ItemPrice"),
  availability: ld.offers?.availability?.replace("https://schema.org/", ""),
  condition: text("ItemDetailsCondition"),
  category: text("ItemDetailsCategory"),
  posted: text("ItemDetailsPosted"),
  shipping: text("ShippingText-DeliveryFeeForBuyer"),
  from: text("ShippingText-ShippingAreaFrom").replace(/^from /, ""),
  seller: text("ItemDetailsSellerName"),
  reviews: text("SellerRatingCount"),
  description: ld.description,
  images: (ld.image ?? []).map((src) => src.replace(/\?.*$/, "")),
});
