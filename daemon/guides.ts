// The guides `safari guide` prints: docs/GUIDE.md for the helper as a
// whole, docs/REPL.md for safari repl, and one per site in docs/sites/.

import { readdir, readFile } from "node:fs/promises";

const DOCS = new URL("../docs/", import.meta.url);

export async function guide(which?: string): Promise<string | null> {
  if (!which) return readFile(new URL("GUIDE.md", DOCS), "utf8");
  if (which === "repl") return readFile(new URL("REPL.md", DOCS), "utf8");
  return siteGuide(which);
}

// docs/sites/<slug>.md, each opening with `name:` and `hosts:` front matter.
// A hosts entry is a domain, optionally with a path prefix (docs.google.com/
// spreadsheets); subdomains match, and the longest matching entry wins.
// "sites" lists them all.
export async function siteGuide(which: string): Promise<string | null> {
  const dir = new URL("sites/", DOCS);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const guides = await Promise.all(files.map(async (f) => {
    const text = await readFile(new URL(f, dir), "utf8");
    const hosts = (/^hosts:(.*)$/m.exec(text)?.[1] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    return { slug: f.slice(0, -3), name: /^name:\s*(.*)$/m.exec(text)?.[1] ?? f, hosts, text };
  }));
  if (which === "sites") return guides.map((g) => `${g.slug.padEnd(18)} ${g.hosts.join(", ")}`).join("\n");
  const q = which.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const named = guides.find((g) => g.slug === q || g.name.toLowerCase() === q);
  if (named) return named.text;
  const slash = q.indexOf("/");
  const [host, path] = slash < 0 ? [q, "/"] : [q.slice(0, slash), q.slice(slash)];
  let best: { text: string; score: number } | null = null;
  for (const g of guides) {
    for (const entry of g.hosts) {
      const cut = entry.indexOf("/");
      const [h, p] = cut < 0 ? [entry, ""] : [entry.slice(0, cut), entry.slice(cut)];
      if ((host === h || host.endsWith(`.${h}`)) && path.startsWith(p) && (!best || entry.length > best.score)) best = { text: g.text, score: entry.length };
    }
  }
  return best?.text ?? null;
}
