// Scrub: checks that a backend holds what the database says, without reading file contents.
//
// It walks the objects under the backend's prefix with ListObjectsV2 (1000 keys and sizes per
// request, the cheapest listing S3 has) and, page by page, the backend's file rows in the same
// order (index blobs_storage_key; object keys are ASCII, so S3's byte order, SQLite's BINARY
// order and JS string order agree). The two sorted streams are merged:
//
// - an active file with no object is `missing`, one whose object has another size `size_mismatch`;
// - an object no row refers to (whatever its state) is `orphaned`; it only takes space;
// - pending uploads and deleted files may or may not have an object: they are not problems.
//
// The listing comes before the rows of the same range, so an upload that starts in between is
// never reported as orphaned (its row exists before its object), and files that became active
// after the listing started (an upload completed, a WebDAV PUT) are skipped rather than reported
// as missing: completing sets created_at. A scrub is bounded per call (`pages`); the
// request that starts it does a few pages and GC continues it. State lives in storages.scrub
// (JSON) and every page is saved with a compare-and-set on the previous state, so two runs
// that overlap cannot count a page twice.
import { all, now, one, run, type DB } from "../db";
import type { Bindings } from "../env";
import type { S3 } from "../lib/s3";
import { storageFor, type StorageRow } from "./storage";

export type ScrubIssue = {
  kind: "missing" | "size_mismatch" | "orphaned";
  key: string;
  project_id?: string;
  blob_id?: string;
  size?: number;
  object_size?: number;
};

export type ScrubState = {
  status: "running" | "done" | "canceled" | "failed";
  started_at: number;
  finished_at: number | null;
  error: string | null;
  objects: number;
  object_bytes: number;
  files: number;
  missing: number;
  size_mismatch: number;
  orphaned: number;
  orphaned_bytes: number;
  issues: ScrubIssue[];
  /** Last object key checked ('' = from the start). Internal. */
  cursor: string;
};

const MAX_ISSUES = 100;
/** Rows read per page; when a range holds more, the page stops at the last row read. */
const ROW_LIMIT = 2000;

export function newScrub(): ScrubState {
  return {
    status: "running",
    started_at: now(),
    finished_at: null,
    error: null,
    objects: 0,
    object_bytes: 0,
    files: 0,
    missing: 0,
    size_mismatch: 0,
    orphaned: 0,
    orphaned_bytes: 0,
    issues: [],
    cursor: "",
  };
}

export const parseScrub = (raw: string | null): ScrubState | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScrubState;
  } catch {
    return null;
  }
};

/** The API shape (without the cursor). */
export function toScrub(raw: string | null) {
  const s = parseScrub(raw);
  if (!s) return null;
  const { cursor: _, ...rest } = s;
  return rest;
}

/** Saves `next` if the scrub is still in state `prev`; false when someone else changed it. */
async function save(db: DB, id: string, prev: string, next: ScrubState) {
  return (await run(db, "UPDATE storages SET scrub = ? WHERE id = ? AND scrub = ?", JSON.stringify(next), id, prev)) > 0;
}

/** Starts (or restarts) a scrub. */
export async function startScrub(db: DB, id: string) {
  await run(db, "UPDATE storages SET scrub = ? WHERE id = ?", JSON.stringify(newScrub()), id);
}

/** Cancels a running scrub; its counters so far are kept. */
export async function cancelScrub(db: DB, id: string) {
  const row = await one<{ scrub: string | null }>(db, "SELECT scrub FROM storages WHERE id = ?", id);
  const s = parseScrub(row?.scrub ?? null);
  if (!row?.scrub || s?.status !== "running") return;
  await save(db, id, row.scrub, { ...s, status: "canceled", finished_at: now() });
}

type FileRow = { id: string; project_id: string; object_key: string; size: number; status: string; created_at: number };

/** Test seams: a stand-in for the backend's client and a smaller row page. */
export type ScrubDeps = { s3?: Pick<S3, "list">; rowLimit?: number };

/**
 * Runs up to `pages` listing requests of a running scrub. Returns the number of S3 requests made.
 * Never throws: a failing backend ends the scrub as `failed`.
 */
export async function scrubStep(
  env: Bindings,
  storage: Pick<StorageRow, "id" | "prefix" | "scrub">,
  pages: number,
  deps: ScrubDeps = {},
): Promise<number> {
  const db = env.DB;
  const rowLimit = deps.rowLimit ?? ROW_LIMIT;
  let raw = storage.scrub;
  let s = parseScrub(raw);
  if (!raw || s?.status !== "running" || pages <= 0) return 0;
  let used = 0;
  try {
    const s3 = deps.s3 ?? (await storageFor(env, storage.id, { any: true })).s3;
    while (used < pages && s.status === "running") {
      used++;
      const listedAt = now();
      const page = await s3.list(storage.prefix, s.cursor);
      // The range this page covers: (cursor, last listed key], or to the end on the last page.
      const last = page.truncated && page.objects.length ? page.objects[page.objects.length - 1].key : null;
      const rows = await all<FileRow>(
        db,
        `SELECT id, project_id, object_key, size, status, created_at FROM blobs INDEXED BY blobs_storage_key
         WHERE storage_id = ? AND object_key > ?${last === null ? "" : " AND object_key <= ?"} AND kind = 'file'
         ORDER BY object_key LIMIT ${rowLimit}`,
        ...(last === null ? [storage.id, s.cursor] : [storage.id, s.cursor, last]),
      );
      // Too many rows for one page: stop at the last row read; the objects after it are listed again.
      let bound = last;
      let objects = page.objects;
      if (rows.length === rowLimit) {
        bound = rows[rows.length - 1].object_key;
        objects = objects.filter((o) => o.key <= bound!);
      }

      const next: ScrubState = { ...s, issues: [...s.issues] };
      const issue = (i: ScrubIssue) => next.issues.length < MAX_ISSUES && next.issues.push(i);
      const sizes = new Map(objects.map((o) => [o.key, o.size]));
      const known = new Set<string>();
      for (const r of rows) {
        known.add(r.object_key);
        if (r.status !== "active" || r.created_at >= listedAt) continue;
        next.files++;
        const size = sizes.get(r.object_key);
        if (size === undefined) {
          next.missing++;
          issue({ kind: "missing", key: r.object_key, project_id: r.project_id, blob_id: r.id, size: r.size });
        } else if (size !== r.size) {
          next.size_mismatch++;
          issue({ kind: "size_mismatch", key: r.object_key, project_id: r.project_id, blob_id: r.id, size: r.size, object_size: size });
        }
      }
      for (const o of objects) {
        next.objects++;
        next.object_bytes += o.size;
        if (!known.has(o.key)) {
          next.orphaned++;
          next.orphaned_bytes += o.size;
          issue({ kind: "orphaned", key: o.key, object_size: o.size });
        }
      }
      if (bound === null) {
        next.status = "done";
        next.finished_at = now();
      } else next.cursor = bound;

      if (!(await save(db, storage.id, raw, next))) return used; // canceled, restarted or advanced elsewhere
      raw = JSON.stringify(next);
      s = next;
    }
  } catch (e) {
    console.error(`scrub: storage ${storage.id}:`, e);
    await save(db, storage.id, raw, { ...s, status: "failed", finished_at: now(), error: (e as Error).message.slice(0, 500) });
  }
  return used;
}
