// The guides `safari guide` prints: docs/GUIDE.md, the short card of rules;
// docs/REFERENCE.md ("reference"), every tool in full; docs/REPL.md for
// safari repl; and one per site in docs/sites/, followed by the notes
// agents have learned on that site (notes.ts).

import { readdir, readFile } from "node:fs/promises";
import { distance } from "./guard.ts";
import { notedHosts, notesSection } from "./notes.ts";

const DOCS = new URL("../docs/", import.meta.url);

export async function guide(which?: string): Promise<string | null> {
  if (!which) return readFile(new URL("GUIDE.md", DOCS), "utf8");
  if (which === "repl") return readFile(new URL("REPL.md", DOCS), "utf8");
  if (which === "reference") return readFile(new URL("REFERENCE.md", DOCS), "utf8");
  return siteGuide(which);
}

// docs/sites/<slug>.md, each opening with `name:` and `hosts:` front matter.
// A hosts entry is a domain, optionally with a path prefix (docs.google.com/
// spreadsheets); subdomains match, and the longest matching entry wins.
// "sites" lists them all, and the hosts with learned notes.
export async function siteGuide(which: string): Promise<string | null> {
  const dir = new URL("sites/", DOCS);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const guides = await Promise.all(files.map(async (f) => {
    const text = await readFile(new URL(f, dir), "utf8");
    const hosts = (/^hosts:(.*)$/m.exec(text)?.[1] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    return { slug: f.slice(0, -3), name: /^name:\s*(.*)$/m.exec(text)?.[1] ?? f, hosts, text };
  }));
  const listing = (gs: typeof guides) => gs.map((g) => `${g.slug.padEnd(18)} ${g.hosts.join(", ")}`).join("\n");
  if (which === "sites") {
    const noted = notedHosts();
    return noted.length ? `${listing(guides)}\n\nlearned notes: ${noted.join(", ")}` : listing(guides);
  }
  const q = which.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const named = guides.find((g) => g.slug === q || g.name.toLowerCase() === q);
  if (named) {
    // a named guide's notes: those of every host its entries cover
    const domains = named.hosts.map((entry) => entry.split("/")[0]);
    return withLearned(named.text, notedHosts().filter((n) => domains.some((d) => covers(d, n))));
  }
  // A bare name is every site with that name among its host's labels:
  // geico is geico.com, discover card.discover.com and discover.com. 16 of
  // 95 lookups from 09-28 to 09-30 gave a bare name and missed.
  if (/^[a-z0-9-]+$/.test(q)) {
    const docs = guides.filter((g) => g.hosts.some((entry) => labels(entry.split("/")[0]).includes(q)));
    const noted = notedHosts().filter((h) => labels(h).includes(q));
    if (docs.length > 1) return withLearned(`${docs.length} guides cover ${q}; ask for one by its name:\n${listing(docs)}`, noted);
    if (docs.length || noted.length) return withLearned(docs[0]?.text ?? null, noted);
  }
  const slash = q.indexOf("/");
  const [host, path] = slash < 0 ? [q, "/"] : [q.slice(0, slash), q.slice(slash)];
  let best: { text: string; score: number } | null = null;
  for (const g of guides) {
    for (const entry of g.hosts) {
      const cut = entry.indexOf("/");
      const [h, p] = cut < 0 ? [entry, ""] : [entry.slice(0, cut), entry.slice(cut)];
      if (covers(h, host) && path.startsWith(p) && (!best || entry.length > best.score)) best = { text: g.text, score: entry.length };
    }
  }
  // The host's notes and its subdomains': uscis.gov found none on 09-30,
  // its notes being on my.uscis.gov and egov.uscis.gov.
  const noteHost = host.replace(/:\d+$/, "");
  return withLearned(best?.text ?? null, notedHosts().filter((h) => covers(noteHost, h)));
}

// Whether host is domain or one of its subdomains.
function covers(domain: string, host: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

// A guide, then the notes learned on each of hosts; null when neither.
function withLearned(text: string | null, hosts: string[]): string | null {
  const learned = hosts.map(notesSection).filter((s) => s !== null);
  if (learned.length === 0) return text;
  return [...(text === null ? [] : [text.trimEnd()]), ...learned].join("\n\n");
}

// Labels that name a door into a site, not the site: on 09-30 the nearest
// noted site to apply.knight-hennessy.stanford.edu, and to smapply, was
// apply.coveredca.com, on the word apply alone.
const DOORS: Record<string, true> = Object.fromEntries(["www", "m", "mobile", "app", "apps", "my", "myaccount", "account", "accounts", "login", "signin", "auth", "id", "sso", "secure", "portal", "apply", "jobs", "careers", "online", "web"].map((l) => [l, true]));

// A host's labels that name it, without the top-level domain or a door:
// geico for geico.com, card and discover for card.discover.com, stanford
// for applygrad.stanford.edu.
function labels(host: string): string[] {
  const all = host.split(".");
  return (all.length > 1 ? all.slice(0, -1) : all).filter((l) => !Object.hasOwn(DOORS, l));
}

// What to say when no guide or notes answer which: the noted hosts nearest
// it, and the call that lists every site (list). $s is a shell variable the
// shell passed as written, as it did for an agent's loop on 09-29.
export function noGuide(which: string, list = "safari guide sites"): string {
  if (/^\$\{?\w+\}?$/.test(which)) return `no guide for ${which}: the shell passed the variable as written, so it was empty or unset, or in single quotes; give the site itself, like geico.com`;
  const asked = labels(which.toLowerCase().replace(/^https?:\/\//, "").split(/[/:]/)[0]);
  // a label two letters or fewer from one asked for, and not all of it
  const near = notedHosts()
    .map((host) => ({ host, d: Math.min(...labels(host).flatMap((l) => asked.flatMap((a) => {
      const d = distance(l, a);
      return d <= 2 && d < Math.min(l.length, a.length) ? [d] : [];
    }))) }))
    .filter(({ d }) => d <= 2)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map(({ host }) => host);
  return `no guide or notes for ${which}; ${near.length ? `nearest with notes: ${near.join(", ")}; ` : ""}every site with a guide or notes: ${list}`;
}
