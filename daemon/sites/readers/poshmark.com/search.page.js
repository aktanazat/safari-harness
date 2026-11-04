const grid = window.__INITIAL_STATE__.$_search.gridData;
({
  total: grid.total_listing_count,
  more: grid.more?.is_next_max_id_present ?? false,
  rows: grid.data.map((x) => ({
    id: x.id,
    url: `https://poshmark.com/listing/${x.id}`,
    title: x.title,
    brand: x.brand,
    price: x.price_amount?.val,
    originalPrice: x.original_price_amount?.val,
    size: x.size_obj?.display ?? x.size,
    status: x.inventory?.status,
    seller: x.creator_username,
    listed: x.first_published_at,
    image: x.cover_shot?.url_large,
  })),
});
