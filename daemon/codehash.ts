// The daemon's code as one hash: everything the daemon runs or reads from
// its own directory. The daemon reports the hash it started with in
// /health, and scripts/dev-install.sh restarts it only when a release's
// differs.
//
//   bun daemon/codehash.ts [DIR]     prints the hash of DIR (default: this one)

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Its code but the tests, docs/ (the guide tool reads it), the extension it
// loads into the hidden Helium, and the sources of the helpers in scripts/
// it runs (each built from its .swift).
const PARTS: Record<string, (file: string) => boolean> = {
  daemon: (f) => !f.endsWith(".test.ts"),
  docs: () => true,
  "passwords-bridge": () => true,
  scripts: (f) => f.endsWith(".swift"),
};

export function codeHash(root = join(import.meta.dir, "..")): string {
  const hash = createHash("sha256");
  for (const [part, wanted] of Object.entries(PARTS)) {
    const dir = join(root, part);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => wanted(f) && !f.split("/").some((seg) => seg.startsWith(".")) && statSync(join(dir, f)).isFile())
      .sort();
    for (const f of files) hash.update(`${part}/${f}\0`).update(readFileSync(join(dir, f))).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

if (import.meta.main) console.log(codeHash(process.argv[2]));
