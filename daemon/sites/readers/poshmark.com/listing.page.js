const x = window.__INITIAL_STATE__.$_listing_details.listingDetails;
({
  id: x.id,
  url: `https://poshmark.com/listing/${x.id}`,
  title: x.title,
  brand: x.brand,
  price: x.price_amount?.val,
  originalPrice: x.original_price_amount?.val,
  size: x.size_obj?.display ?? x.size,
  status: x.inventory?.status,
  description: x.description,
  seller: x.creator_username,
  listed: x.first_published_at,
  likes: x.like_count,
  images: x.pictures?.map((p) => p.url_large) ?? [x.cover_shot?.url_large],
});
