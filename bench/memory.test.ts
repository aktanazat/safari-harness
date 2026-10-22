import { expect } from "bun:test";
import { benchRows } from "./bench.ts";

const url = new URL("./fixtures/memory.html", import.meta.url).href;
const source = new URL("./fixtures/form.html", import.meta.url).href;

benchRows("browser memory in WebKit", [
  {
    name: "captures readable page facts, including open shadow text, without hidden text, forms, or private elements",
    page: "memory.html",
    steps: [{ op: "memoryPage", args: [url], answer: { value: {
      url,
      body: expect.stringMatching(/^(?=[\s\S]*oxygen emissions at 557\.7 nanometers)(?=[\s\S]*used a spectrometer)(?![\s\S]*SENTINEL)[\s\S]+$/),
    } } }],
  },
  {
    name: "does not collect an unsent ordinary draft or the preview that echoes it",
    page: "memory.html",
    steps: [
      { op: "type", args: ["#draft", "UNSENT-DRAFT-SENTINEL"] },
      { op: "memoryPage", args: [url], answer: { value: { skipped: true } } },
    ],
  },
  {
    name: "does not collect a filled rich editor inside a shadow root",
    page: "memory.html",
    steps: [
      { op: "type", args: ["#shadow-editor", "UNSENT-RICH-SENTINEL"] },
      { op: "memoryPage", args: [url], answer: { value: { skipped: true } } },
    ],
  },
  {
    name: "does not collect an article inside a private ancestor",
    page: "memory.html",
    steps: [
      { op: "eval", args: ['(document.body.setAttribute("data-private", ""), true)'] },
      { op: "memoryPage", args: [url], answer: { value: { skipped: true } } },
    ],
  },
  {
    name: "does not collect an article inside a sensitive ancestor",
    page: "memory.html",
    steps: [
      { op: "eval", args: ['(document.body.setAttribute("data-sensitive", ""), true)'] },
      { op: "memoryPage", args: [url], answer: { value: { skipped: true } } },
    ],
  },
  {
    name: "does not collect an article hidden by an ancestor",
    page: "memory.html",
    steps: [
      { op: "eval", args: ['(document.body.style.display = "none", true)'] },
      { op: "memoryPage", args: [url], answer: { value: { skipped: true } } },
    ],
  },
  {
    name: "does not collect an article made transparent by an ancestor",
    page: "memory.html",
    steps: [
      { op: "eval", args: ['(document.body.style.opacity = "0", true)'] },
      { op: "memoryPage", args: [url], answer: { value: { skipped: true } } },
    ],
  },
  {
    name: "does not collect an article slotted into a private shadow ancestor",
    page: "memory.html",
    steps: [
      { op: "eval", args: [`(() => {
        const host = document.createElement("div");
        host.attachShadow({ mode: "open" }).innerHTML = "<section data-private><slot></slot></section>";
        document.body.append(host);
        host.append(document.querySelector("main"));
        return true;
      })()`] },
      { op: "memoryPage", args: [url], answer: { value: { skipped: true } } },
    ],
  },
  {
    name: "does not collect a credential page even when readable content surrounds it",
    page: "form.html",
    steps: [{ op: "memoryPage", args: [source], answer: { value: { skipped: true } } }],
  },
  {
    name: "does not return a different document after navigation",
    page: "memory.html",
    steps: [{ op: "memoryPage", args: ["https://example.com/before"], answer: { value: { skipped: true } } }],
  },
]);
