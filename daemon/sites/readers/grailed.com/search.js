const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
({
  heading: text(document.querySelector("[class*=Header_stats]")),
  rows: [...document.querySelectorAll("[class*=UserItem_root]")].map((card) => {
    const link = card.querySelector("a[href*='/listings/']");
    const id = /\/listings\/(\d+)/.exec(link?.href ?? "")?.[1];
    return {
      id,
      url: `https://www.grailed.com/listings/${id}`,
      title: text(card.querySelector("[class*=UserItem_title]")),
      designer: text(card.querySelector("[class*=UserItem_designer__]")),
      size: text(card.querySelector("[class*=UserItem_size]")),
      price: text(card.querySelector("[data-testid=Current]")),
      age: text(card.querySelector("[class*=Timestamp_date]")),
      image: card.querySelector("img")?.src.replace(/\?.*$/, ""),
    };
  }),
});
