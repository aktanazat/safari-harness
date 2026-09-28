// Records the live pages of daemon/challenge-corpus.json again, in background
// tabs of the running harness, with the probe the daemon sends now. Run it
// after changing the markers, answer fields, or text limit in challenge.ts,
// read the texts it prints for anything personal, and commit the corpus.
// Pages saved from a wall (source.saved) keep what they recorded.
//   bun scripts/record-challenges.ts

import { PROBE, classify, type Facts } from "../daemon/challenge.ts";
import { rpc } from "../daemon/rpc.ts";

type Page = { name: string; source: { url: string; saved?: string }; expect: unknown; frames: Facts[] };
const CORPUS = new URL("../daemon/challenge-corpus.json", import.meta.url);

// Long query values are tokens and cookies.
const cut = (u: string) => u.replace(/([?&#][\w-]+=)([^&#]{25,})/g, "$1…");

const corpus = (await Bun.file(CORPUS).json()) as { asked: typeof PROBE; pages: Page[] };
for (const page of corpus.pages.filter((p) => !p.source.saved)) {
  const { id: tab } = (await rpc("open", { url: page.source.url, background: true })) as { id: number };
  try {
    await Bun.sleep(5000); // walls and boxes draw themselves after load
    const { result: f } = (await rpc("eval", { tab, expression: `window.__safariHarnessProbe.challenge(${JSON.stringify(PROBE)})` })) as { result: Facts };
    page.frames = [{ url: cut(f.url), title: f.title, text: f.text, markers: f.markers, answered: f.answered, frames: f.frames.map(cut) }];
  } finally {
    await rpc("close", { tab });
  }
  const got = classify(page.frames) ?? null;
  const same = JSON.stringify(got) === JSON.stringify(page.expect);
  console.log(`${same ? "ok  " : "DIFF"} ${page.name}: ${JSON.stringify(got)}${same ? "" : ` (expected ${JSON.stringify(page.expect)})`}`);
  if (page.frames[0].text) console.log(`     text: ${page.frames[0].text}`);
}
await Bun.write(CORPUS, JSON.stringify({ ...corpus, asked: PROBE }, null, 1) + "\n");
