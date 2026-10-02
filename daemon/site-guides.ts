// The bundled site guides, docs/sites/<slug>.md, each opening with `name:`
// and `hosts:` front matter. A hosts entry is a domain, optionally with a
// path prefix (docs.google.com/spreadsheets); subdomains match, and the
// longest matching entry wins. `real-input: true` marks the guide's hosts
// for real input, as learn {site, real: true} does (notes.ts). `safari
// guide` prints them (guides.ts); the first result on a site names its own
// (tools.ts).

import { readdirSync, readFileSync } from "node:fs";

const SITES = new URL("../docs/sites/", import.meta.url);

export type Guide = { slug: string; name: string; hosts: string[]; real: boolean; text: string };

export function bundled(): Guide[] {
  return readdirSync(SITES).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const text = readFileSync(new URL(f, SITES), "utf8");
    const hosts = (/^hosts:(.*)$/m.exec(text)?.[1] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    return { slug: f.slice(0, -3), name: /^name:\s*(.*)$/m.exec(text)?.[1] ?? f, hosts, real: /^real-input:\s*true\s*$/m.test(text), text };
  });
}

// Whether host is domain or one of its subdomains.
export function covers(domain: string, host: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

// The guide whose hosts entry covers host and path, the longest if several.
export function covering(guides: Guide[], host: string, path: string): Guide | undefined {
  let best: { guide: Guide; score: number } | undefined;
  for (const guide of guides) {
    for (const entry of guide.hosts) {
      const cut = entry.indexOf("/");
      const [h, p] = cut < 0 ? [entry, ""] : [entry.slice(0, cut), entry.slice(cut)];
      if (covers(h, host) && path.startsWith(p) && (!best || entry.length > best.score)) best = { guide, score: entry.length };
    }
  }
  return best?.guide;
}

// The name of the bundled guide for the page at url, which the first
// result on its host carries: 39 of 77 `safari guide <site>` lookups on
// 10-01 and 10-02 found none, run before every site.
export function guideFor(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const { hostname, pathname } = new URL(url);
  return covering(bundled(), hostname, pathname)?.slug;
}
