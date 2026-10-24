const meta = document.querySelector("meta[name=description]")?.content ?? "";
const head = /^(.*?) - (\S+) on ([^:]+): "/s.exec(meta);
({
  url: location.href,
  user: head?.[2],
  counts: head?.[1],
  date: document.querySelector("main time[datetime]")?.getAttribute("datetime"),
  caption: meta.slice(head?.[0].length ?? 0).replace(/"\.?\s*$/, ""),
  images: [...new Set([...document.querySelectorAll("main img")].filter((i) => !i.closest("a") && !/_s\d+x\d+/.test(i.src)).map((i) => i.src))],
  video: !!document.querySelector("main video"),
  more: !!document.querySelector("main button[aria-label=Next]"),
});
