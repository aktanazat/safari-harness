// Fingerprints: how the harness finds an element again after the page drew
// it anew. content.js takes one of each element it gives a ref, and of the
// target of each step it records: what the element is (role, accessible
// name, tag), the opening text of its row or box (near), a short CSS path,
// and which it was among the elements that looked the same (index of
// count). A ref whose element a framework re-render replaced then heals to
// its replacement, and a replay finds each step's target on a fresh page.

export type Fingerprint = { role: string; name: string; tag: string; near: string; path: string; index: number; count: number };

// An element on the page now, described the same way.
export type Candidate = { role: string; name: string; tag: string; near: string; path: string };

// The one candidate the fingerprint names, or how many look like it when
// none is clearly the one (0: nothing does).
export type Match = { index: number } | { count: number };

// content.js carries these two bodies, between its "shared with
// daemon/fingerprint.ts" markers, to heal a stale ref inside the page;
// fingerprint.test.ts runs both copies on one table. A guess here clicks
// the wrong element, so lookalikes (each row's "Delete") resolve only on
// the evidence of their surroundings, and an element that was one of
// several never passes for the only one left.
export function lookalikeKey(c: { role: string; name: string; tag: string }): string {
  return `${c.role}\n${c.name}\n${c.tag}`;
}

export function matchFingerprint(fp: Fingerprint, candidates: readonly Candidate[]): Match {
  const want = lookalikeKey(fp);
  const same = [];
  for (let i = 0; i < candidates.length; i++) if (lookalikeKey(candidates[i]) === want) same.push(i);
  if (same.length === 1 && fp.count === 1) return { index: same[0] };
  // One of several lookalikes, then or now: the one whose surroundings read
  // the same; among several of those, the one on the same path, or the one
  // at the same place among as many lookalikes as before.
  const kin = same.filter((i) => candidates[i].near === fp.near);
  if (kin.length === 1) return { index: kin[0] };
  const onPath = kin.filter((i) => candidates[i].path === fp.path);
  if (onPath.length === 1) return { index: onPath[0] };
  const placed = same[fp.index];
  if (same.length === fp.count && kin.includes(placed)) return { index: placed };
  return { count: same.length };
}

// How an error names what it looked for: `button "Save"`.
export function describe(fp: Fingerprint): string {
  return fp.name ? `${fp.role} "${fp.name}"` : fp.role;
}

// Why a fingerprint named no one element, from the count a Match gave.
export function unmatched(fp: Fingerprint, count: number): string {
  if (count === 0) return `nothing on the page looks like ${describe(fp)}`;
  return `${count} element${count === 1 ? "" : "s"} on the page look${count === 1 ? "s" : ""} like ${describe(fp)}, and none is clearly the one recorded`;
}

export function isFingerprint(v: unknown): v is Fingerprint {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return ["role", "name", "tag", "near", "path"].every((k) => typeof f[k] === "string") && f.tag !== ""
    && Number.isInteger(f.index) && Number.isInteger(f.count);
}
