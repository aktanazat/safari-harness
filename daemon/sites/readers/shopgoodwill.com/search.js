const showing = /Showing (\d+) to (\d+) of ([\d,]+) entries/.exec(document.body.innerText);
({
  showing: showing?.[0],
  total: showing ? Number(showing[3].replace(/,/g, "")) : 0,
  rows: [...document.querySelectorAll(".feat-item")].map((card) => {
    const name = card.querySelector("a.feat-item_name");
    const info = card.innerText;
    return {
      id: name?.id,
      url: `https://shopgoodwill.com/item/${name?.id}`,
      title: name?.title,
      price: card.querySelector(".feat-item_price")?.textContent.trim(),
      bids: /Bids:\s*(\d+)/.exec(info)?.[1],
      timeLeft: /Time remaining:\s*([^\n]+?)\s*(?:Quick Bid|$)/m.exec(info)?.[1],
      image: card.querySelector("img.feat-item_img")?.src.replace(/\\/g, "/").replace(/t(\d+)\.jpeg$/, "$1.jpg"),
    };
  }),
});
