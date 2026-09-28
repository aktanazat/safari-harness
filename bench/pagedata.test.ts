import { expect } from "bun:test";
import { benchRows } from "./bench.ts";

// The data tool's page half, eval's helpers and policy answer, and typing
// into a rich editor, as content.js answers in Safari's WebKit.
benchRows("content.js page data, eval, and editors in WebKit", [
  {
    name: "data reads the page's JSON-LD, Next.js state, JSON scripts, main-region data attributes, microdata, and meta tags, and skips JSON that does not parse",
    page: "data.html",
    steps: [{
      op: "data",
      answer: {
        value: {
          title: "Trail shoe",
          jsonld: [{ "@type": "Product", name: "Trail shoe", offers: { price: "89.00", priceCurrency: "USD" } }],
          next: { props: { pageProps: { product: { id: 7, stock: 3 } } } },
          scripts: [{ id: "reviews", value: { count: 12, average: 4.5 } }],
          attrs: [{ el: "div#card.card.wide", "data-product": { sku: "TS-7", sizes: [9, 10] } }],
          microdata: [{ type: "https://schema.org/Product", props: { name: "Trail shoe", brand: { type: "https://schema.org/Brand", props: { name: "Trailworks" } }, offers: { type: "https://schema.org/Offer", props: { price: "89.00", priceCurrency: "USD" } } } }],
          meta: { description: "A light trail shoe", "og:image": ["https://shop.example/a.jpg", "https://shop.example/b.jpg"], canonical: "https://shop.example/p/trail-shoe" },
        },
      },
    }],
  },
  {
    name: "eval's sh.q and sh.qa find elements inside shadow roots, where the page's own queries stop",
    page: "shadow.html",
    steps: [{
      op: "eval",
      args: ['[document.querySelectorAll("button").length, sh.qa("button").map((b) => b.textContent), sh.q("h2").localName]'],
      answer: { value: { ok: true, result: [0, ["Follow"], "h2"] } },
    }],
  },
  {
    name: "eval's sh.jsonld reads the page's JSON-LD",
    page: "data.html",
    steps: [{ op: "eval", args: ["sh.jsonld().map((d) => d.offers.price)"], answer: { value: { ok: true, result: ["89.00"] } } }],
  },
  {
    name: "typing replaces a rich editor's text in the editor's own model, not only on screen",
    page: "editor.html",
    steps: [
      { op: "snapshot" }, // [1] Message
      { op: "type", args: ["1", "New text"], answer: { value: { ok: true, kept: true } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Editor holds: New text.") } } },
    ],
  },
  {
    name: "typing nothing clears a rich editor's model",
    page: "editor.html",
    steps: [
      { op: "snapshot" }, // [1] Message
      { op: "type", args: ["1", ""], answer: { value: { ok: true, kept: true } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Editor holds: .") } } },
    ],
  },
  {
    name: "typing with append adds to the end of a rich editor's model",
    page: "editor.html",
    steps: [
      { op: "snapshot" }, // [1] Message
      { op: "type", args: ["1", " and more", { append: true }], answer: { value: { ok: true, kept: true } } },
      { op: "extract", answer: { value: { text: expect.stringContaining("Editor holds: Old notes and more.") } } },
    ],
  },
]);
