const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const heading = text(document.querySelector(".srp-controls__count-heading"));
const exact = !document.querySelector(".srp-save-null-search") && !heading.startsWith("0 results");
const rows = [...document.querySelectorAll("ul.srp-results > li[data-listingid]")].map((li) => {
  const id = /\/itm\/(\d+)/.exec(li.querySelector("a.s-card__link")?.href ?? "")?.[1];
  const attrs = [...li.querySelectorAll(".s-card__attribute-row")].map(text);
  const price = text(li.querySelector(".s-card__price"));
  return {
    id,
    url: `https://www.ebay.com/itm/${id}`,
    title: text(li.querySelector(".s-card__title")).replace(/Opens in a new window or tab$/, ""),
    price,
    condition: text(li.querySelector(".s-card__subtitle")),
    sold: /^Sold (.+)/.exec(text(li.querySelector(".s-card__caption")))?.[1],
    shipping: attrs.find((a) => /delivery|shipping/i.test(a)),
    location: attrs.find((a) => a.startsWith("Located in "))?.slice(11),
    seller: attrs.find((a) => / positive \(/.test(a)),
    details: attrs.filter((a) => !a.startsWith(price) && !/delivery|shipping|^Located in | positive \(|^View similar|^Sell one like this/i.test(a)),
    image: li.querySelector("img")?.src.replace(/\/s-l\d+\./, "/s-l1600."),
  };
});
exact ? { heading, exact, rows } : { heading, exact, rows: [], unrelated: rows.length };
