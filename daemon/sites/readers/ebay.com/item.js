const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const value = (s) => text(document.querySelector(`${s} .ux-labels-values__values`));
const shipping = /^(.*?)\.? See details\s*for shipping(?:Located in: (.*))?/.exec(value(".ux-labels-values--shipping"));
({
  id: /\/itm\/(\d+)/.exec(location.pathname)?.[1],
  title: text(document.querySelector("h1")),
  price: text(document.querySelector("[data-testid=x-price-primary]")),
  status: text(document.querySelector("[data-testid=d-statusmessage]")) || undefined,
  seller: /\/(?:sch|str|usr)\/([^/?]+)/.exec(document.querySelector("[data-testid=x-sellercard-atf] a[href*='/sch/'], [data-testid=x-sellercard-atf] a[href*='/str/'], [data-testid=x-sellercard-atf] a[href*='/usr/']")?.href ?? "")?.[1],
  shipping: shipping?.[1] ?? value(".ux-labels-values--shipping"),
  location: shipping?.[2],
  returns: value(".ux-labels-values--returns").replace(/\.? See details.*$/, ""),
  specifics: Object.fromEntries([...document.querySelectorAll(".x-about-this-item dt")].map((dt) => [text(dt), text(dt.nextElementSibling).replace(/ Read more.*$/, "")])),
  images: [...new Set([...document.querySelectorAll(".ux-image-carousel-item img")].map((img) => img.dataset.zoomSrc || img.dataset.src || img.src))],
  description: document.querySelector("iframe#desc_ifr")?.src,
});
