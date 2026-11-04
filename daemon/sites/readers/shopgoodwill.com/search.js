const body = document.body.innerText;
const showing = /Showing ([\d,]+) to ([\d,]+) of ([\d,]+) entries/.exec(body);
const empty = /Oops!\s*We have a lot of items on ShopGoodwill\.com but can't seem to find that one\./.test(body);
const cards = [...document.querySelectorAll(".feat-item")];
if (!showing && !empty) throw new Error("the ShopGoodwill search results are not ready; wait for the result count or the site's no-results message, and check the search URL");
const total = showing ? Number(showing[3].replace(/,/g, "")) : 0;
if (empty && (total > 0 || cards.length)) throw new Error("the ShopGoodwill search results are still changing; the no-results message and listings disagree");
const rows = cards.flatMap((card) => {
  const name = card.querySelector("a.feat-item_name");
  const id = name?.id;
  if (!id || !/^[1-9]\d*$/.test(id)) return [];
  const info = card.innerText;
  return [{
    id,
    url: `https://shopgoodwill.com/item/${id}`,
    title: name.title,
    price: card.querySelector(".feat-item_price")?.textContent.trim(),
    bids: /Bids:\s*(\d+)/.exec(info)?.[1],
    timeLeft: /Time remaining:\s*([^\n]+?)\s*(?:Quick Bid|$)/m.exec(info)?.[1],
    image: card.querySelector("img.feat-item_img")?.src.replace(/\\/g, "/").replace(/t(\d+)\.jpeg$/, "$1.jpg"),
  }];
});
if (total > 0 && !rows.length) throw new Error("the ShopGoodwill search reports results but has no readable listings yet");
if (total === 0 && cards.length) throw new Error("the ShopGoodwill search results are still changing; the result count and listings disagree");
({ status: total === 0 ? "empty" : "ready", showing: showing?.[0], total, rows, skipped: cards.length - rows.length });
