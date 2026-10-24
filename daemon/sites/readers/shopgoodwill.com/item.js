const t = document.body.innerText;
const field = (label) => new RegExp(`${label}:\\s*([^\\n]+)`).exec(t)?.[1].trim();
const desc = t.indexOf("Item Description\n");
const gallery = [...document.querySelectorAll(".ngx-gallery-thumbnail, .ngx-gallery-image")].map((e) => /url\("?([^")]+)/.exec(e.getAttribute("style") ?? "")?.[1]).filter(Boolean);
({
  id: field("Item ID"),
  url: location.href,
  title: document.querySelector("h1")?.textContent.trim(),
  price: field("Current Price"),
  minimumBid: field("Minimum Bid"),
  bids: field("Number of Bids"),
  timeLeft: field("Time left")?.replace(/\s*\(update\).*$/, ""),
  endsOn: field("Ends On"),
  shipping: field("Shipping Price"),
  handling: field("Handling Price"),
  seller: field("Seller"),
  description: desc < 0 ? undefined : t.slice(desc + 17).split("View More")[0].trim(),
  images: [...new Set((gallery.length ? gallery : [...document.querySelectorAll("img")].map((i) => i.src).filter((s) => s.includes("/Items/"))).map((s) => s.replace(/\\/g, "/").replace(/t(\d+)\.jpeg$/, "$1.jpg")))],
});
