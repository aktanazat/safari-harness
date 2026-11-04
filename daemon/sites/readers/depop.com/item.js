const found = {};
const walk = (v) => {
  if (Array.isArray(v)) return v.forEach(walk);
  if (!v || typeof v !== "object") return;
  if (v.pictures && v.description !== undefined) found.product ??= v;
  if (v.totalCurrentPrice !== undefined) found.price ??= v;
  Object.values(v).forEach(walk);
};
const flight = [...document.scripts].map((s) => s.textContent).filter((t) => t.startsWith("self.__next_f.push([1,")).map((t) => JSON.parse(t.slice(t.indexOf("(") + 1, t.lastIndexOf(")")))[1]).join("");
for (const row of flight.split("\n")) {
  const json = /^[0-9a-f]+:([[{].*)$/s.exec(row)?.[1];
  if (json) walk(JSON.parse(json));
}
const p = found.product;
const price = found.price;
({
  id: p.id,
  url: `https://www.depop.com/products/${p.slug}/`,
  title: document.querySelector("h1")?.textContent.trim(),
  brand: p.brand_name,
  status: p.status,
  attributes: p.attributes,
  sizes: p.variants_all,
  description: p.description,
  seller: p.seller?.username,
  location: p.location,
  price: price && { currency: price.currencyName, price: price.baseCurrentPrice, original: price.baseOriginalPrice, shipping: price.shippingCost, fees: price.currentPriceFees, total: price.totalCurrentPrice },
  images: p.pictures.map((pic) => pic.formats?.P0?.url).filter(Boolean),
});
