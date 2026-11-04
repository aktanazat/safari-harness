import { randomUUID } from "node:crypto";

export type SnapshotView = { root?: string; query?: string; maxNodes?: number; showHidden?: boolean; interactive?: boolean };
type SnapshotPage = { url: string; snapshot: string; documentId?: string };
type Baseline = SnapshotPage & { key: string; tab: number; revision: string; bytes: number };
export type SnapshotObservation = { revision: string; previous?: string; base?: Baseline; reason: string };
export type SnapshotEdit = { start: number; deleteCount: number; lines: string[] };
export type SnapshotUpdate = {
  kind: "full" | "unchanged" | "delta";
  revision: string;
  baseRevision: string | null;
  edits?: SnapshotEdit[];
  reason?: string;
};

// Historical revisions and the latest legacy diff share the same text. The
// limits cover every owner and read view together, including old revisions
// retained so a caller can recover an update it did not receive.
const REVISIONS_KEPT = 128;
const REVISION_BYTES = 4 * 1024 * 1024;

export class SnapshotHistory {
  private readonly revisions = new Map<string, Baseline>();
  private readonly latest = new Map<string, string>();
  private bytes = 0;

  forget(tab: number): void {
    for (const [revision, entry] of this.revisions) if (entry.tab === tab) this.drop(revision, entry);
  }

  observe(page: SnapshotPage, tab: number, owner: number | undefined, view: SnapshotView & { fallback?: boolean }, since?: string): SnapshotObservation {
    let documentChanged = false;
    for (const entry of this.revisions.values()) {
      if (entry.tab === tab && (entry.url !== page.url || entry.documentId !== page.documentId)) {
        this.forget(tab);
        documentChanged = true;
        break;
      }
    }
    const key = JSON.stringify([owner ?? null, tab, view.root ?? null, view.query ?? null, view.maxNodes || 600, view.showHidden === true, view.interactive === true, view.fallback === true]);
    const previous = this.revisions.get(this.latest.get(key) ?? "");
    const known = since === undefined ? undefined : this.revisions.get(since);
    const base = known?.key === key ? known : undefined;
    const reason = !page.documentId ? "identity-unavailable" : documentChanged ? "document-changed" : since === undefined ? "initial" : base ? "" : known?.tab === tab ? "view-changed" : "base-unavailable";
    let revision = previous?.snapshot === page.snapshot ? previous.revision : undefined;
    if (revision !== undefined && previous) {
      this.revisions.delete(revision);
      this.revisions.set(revision, previous);
    } else {
      revision = randomUUID();
      this.latest.delete(key);
      const bytes = Buffer.byteLength(page.snapshot) + Buffer.byteLength(page.url) + Buffer.byteLength(page.documentId ?? "") + Buffer.byteLength(key) + revision.length;
      if (bytes <= REVISION_BYTES) {
        const entry = { key, tab, url: page.url, documentId: page.documentId, snapshot: page.snapshot, revision, bytes };
        this.revisions.set(revision, entry);
        this.latest.set(key, revision);
        this.bytes += bytes;
        while (this.revisions.size > REVISIONS_KEPT || this.bytes > REVISION_BYTES) {
          const oldest = this.revisions.entries().next().value;
          if (!oldest) break;
          this.drop(...oldest);
        }
      }
    }
    return { revision, previous: previous?.snapshot, ...(base && page.documentId ? { base } : {}), reason };
  }

  private drop(revision: string, entry: Baseline): void {
    this.revisions.delete(revision);
    this.bytes -= entry.bytes;
    if (this.latest.get(entry.key) === revision) this.latest.delete(entry.key);
  }
}

export function recoverSnapshot<T extends SnapshotPage>(page: T, observed: SnapshotObservation, forceFull?: string): T & { update: SnapshotUpdate } {
  const full = (reason: string): T & { update: SnapshotUpdate } => ({ ...page, update: { kind: "full", revision: observed.revision, baseRevision: null, reason } });
  const base = observed.base;
  if (forceFull || !base) return full(forceFull ?? observed.reason);
  if (base.snapshot === page.snapshot) return { ...page, snapshot: "", update: { kind: "unchanged", revision: observed.revision, baseRevision: base.revision } };

  // One splice between the common prefix and suffix is linear, preserves
  // duplicate lines and indentation, and applies against the exact base.
  // A scattered change can be larger than a full snapshot; send full then.
  const before = base.snapshot.split("\n");
  const after = page.snapshot.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta: T & { update: SnapshotUpdate } = {
    ...page,
    snapshot: "",
    update: { kind: "delta", revision: observed.revision, baseRevision: base.revision, edits: [{ start, deleteCount: oldEnd - start, lines: after.slice(start, newEnd) }] },
  };
  const replacement = full("delta-not-smaller");
  return Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(replacement)) ? delta : replacement;
}
