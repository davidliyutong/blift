// Directories. A directory is a blobs row of kind 'dir'; every row names its directory in
// parent_id ('' = the project's root). Paths are therefore never stored: they are resolved by
// walking at most MAX_DEPTH rows, and moving or renaming a directory writes one row however much
// it holds. Deleting one only flags it; `drainDeletedDirs` releases what was inside, a bounded
// amount per call (see "Cloudflare limits" in AGENTS.md).
import { all, chunks, now, one, placeholders, run, stmt, type DB, type Stmt } from "../db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { blobName } from "../lib/http";
import { newId } from "../lib/ids";
import { deleteBlobs, toBlob, type BlobRow } from "./projects";

/** Directories nest at most this deep (a file may sit in a directory of that depth). */
export const MAX_DEPTH = 16;
export const DIR_CONTENT_TYPE = "inode/directory";

const nameTaken = () => conflict("name_taken", "a file or directory with this name already exists");
const tooDeep = () => badRequest(`directories nest at most ${MAX_DEPTH} levels deep`);

/** D1 and node:sqlite both report a violated unique index this way. */
export const isUniqueError = (e: unknown) => /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));

/** "a/b/c" → ["a", "b", "c"], each a valid name; "" and "/" are the root (no segments). */
export function splitPath(v: unknown, field = "path"): string[] {
  if (v === undefined || v === null || v === "") return [];
  if (typeof v !== "string") throw badRequest(`${field} must be a string`);
  const segs = v.split("/").filter(Boolean).map(blobName);
  if (segs.length > MAX_DEPTH + 1) throw tooDeep();
  return segs;
}

type Step = { id: string; name: string };

/**
 * The rows `segs` names below directory `from`, as far as they exist (one query): the result is
 * shorter than `segs` when the path does not exist.
 */
export function walkPath(db: DB, projectId: string, segs: string[], from = ""): Promise<BlobRow[]> {
  if (segs.length === 0) return Promise.resolve([]);
  return all<BlobRow>(
    db,
    `WITH RECURSIVE seg(i, name) AS (SELECT key, value FROM json_each(?)),
     walk(i, id) AS (
       SELECT 0, ?
       UNION ALL
       SELECT w.i + 1, b.id FROM walk w JOIN blobs b INDEXED BY blobs_project_name
         ON b.project_id = ? AND b.parent_id = w.id AND b.status = 'active'
        AND b.name = (SELECT name FROM seg WHERE seg.i = w.i)
     )
     SELECT b.* FROM walk w JOIN blobs b ON b.id = w.id WHERE w.i > 0 ORDER BY w.i`,
    JSON.stringify(segs),
    from,
    projectId,
  );
}

/** The blob at `segs` below `from`, or null. */
export async function findPath(db: DB, projectId: string, segs: string[], from = ""): Promise<BlobRow | null> {
  const rows = await walkPath(db, projectId, segs, from);
  return rows.length === segs.length && segs.length > 0 ? rows[rows.length - 1] : null;
}

/**
 * The ancestors of each directory in `ids`, root first and ending with the directory itself.
 * The root ('') has an empty chain.
 */
export async function chainsOf(db: DB, ids: string[]): Promise<Map<string, Step[]>> {
  const out = new Map<string, Step[]>([["", []]]);
  const want = [...new Set(ids)].filter(Boolean);
  for (const part of chunks(want)) {
    const rows = await all<{ start: string; id: string; name: string; depth: number }>(
      db,
      `WITH RECURSIVE up(start, id, parent_id, name, depth) AS (
         SELECT id, id, parent_id, name, 0 FROM blobs WHERE id IN (${placeholders(part.length)})
         UNION ALL
         SELECT up.start, b.id, b.parent_id, b.name, up.depth + 1 FROM up JOIN blobs b ON b.id = up.parent_id
         WHERE up.depth < ${MAX_DEPTH * 2}
       )
       SELECT start, id, name, depth FROM up ORDER BY depth DESC`,
      ...part,
    );
    for (const r of rows) {
      const chain = out.get(r.start) ?? [];
      chain.push({ id: r.id, name: r.name });
      out.set(r.start, chain);
    }
  }
  return out;
}

export const chainOf = async (db: DB, id: string) => (await chainsOf(db, [id])).get(id) ?? [];

const join = (chain: Step[], name?: string) => [...chain.map((s) => s.name), ...(name === undefined ? [] : [name])].join("/");

/** API shape of rows, each with its path in the project. */
export async function withPaths(db: DB, rows: BlobRow[]) {
  const chains = await chainsOf(db, rows.map((r) => r.parent_id));
  return rows.map((r) => toBlob(r, join(chains.get(r.parent_id) ?? [], r.name)));
}

export const withPath = async (db: DB, row: BlobRow) => (await withPaths(db, [row]))[0];

/** What a directory listing says about the directory itself. */
export const dirInfo = (chain: Step[]) => ({
  id: chain.length ? chain[chain.length - 1].id : null,
  path: join(chain),
  parents: chain.slice(0, -1),
});

/**
 * Checks that `id` is an active directory of the project and returns its parent_id value
 * ('' for the root, which null, undefined and "" all mean).
 */
export async function requireDir(db: DB, projectId: string, id: unknown): Promise<string> {
  if (id === undefined || id === null || id === "") return "";
  const dir = await one(db, "SELECT 1 AS x FROM blobs WHERE id = ? AND project_id = ? AND kind = 'dir' AND status = 'active'", id, projectId);
  if (!dir) throw notFound("directory");
  return String(id);
}

const insertDir = (db: DB, projectId: string, parentId: string, id: string, name: string, userId: string | null, t: number) =>
  stmt(
    db,
    `INSERT INTO blobs (id, project_id, parent_id, kind, storage_id, object_key, name, size, content_type, status, uploader_id, created_at, updated_at)
     VALUES (?, ?, ?, 'dir', '', '', ?, 0, '${DIR_CONTENT_TYPE}', 'active', ?, ?, ?)`,
    id,
    projectId,
    parentId,
    name,
    userId,
    t,
    t,
  );

/**
 * mkdir: creates the directory `segs` below `from`. With `parents` it works like `mkdir -p`:
 * missing directories on the way are created and an existing directory is returned as it is.
 */
export async function makeDirs(
  db: DB,
  projectId: string,
  from: string,
  segs: string[],
  o: { parents: boolean; userId: string | null },
): Promise<{ dir: BlobRow; created: boolean }> {
  if (segs.length === 0) throw badRequest("path is required");
  const base = (await chainOf(db, from)).length;
  if (base + segs.length > MAX_DEPTH) throw tooDeep();
  // Twice: when another request creates the same directories at the same time, the second pass
  // finds them.
  for (let attempt = 0; ; attempt++) {
    const have = await walkPath(db, projectId, segs, from);
    if (have.some((r) => r.kind !== "dir")) throw nameTaken();
    if (have.length === segs.length) {
      if (!o.parents) throw nameTaken();
      return { dir: have[have.length - 1], created: false };
    }
    if (!o.parents && have.length < segs.length - 1) throw notFound("directory");
    const t = now();
    let parent = have.length ? have[have.length - 1].id : from;
    const stmts: Stmt[] = [];
    for (const name of segs.slice(have.length)) {
      const id = newId();
      stmts.push(insertDir(db, projectId, parent, id, name, o.userId, t));
      parent = id;
    }
    try {
      await db.batch(stmts);
    } catch (e) {
      if (!isUniqueError(e) || attempt > 0) throw e;
      continue;
    }
    return { dir: (await one<BlobRow>(db, "SELECT * FROM blobs WHERE id = ?", parent))!, created: true };
  }
}

/**
 * Checks that the directories among `rows` may move into directory `to`: not into themselves or
 * something below them, and not deeper than MAX_DEPTH.
 */
async function checkMove(db: DB, projectId: string, rows: Pick<BlobRow, "id" | "kind">[], to: string) {
  const dirs = rows.filter((r) => r.kind === "dir").map((r) => r.id);
  if (dirs.length === 0) return;
  const chain = await chainOf(db, to);
  if (chain.some((s) => dirs.includes(s.id))) throw badRequest("a directory cannot be moved into itself");
  // Height of each moved tree: only directory rows are read.
  for (const part of chunks(dirs)) {
    const deepest = await one<{ d: number }>(
      db,
      `WITH RECURSIVE down(id, d) AS (
         SELECT id, 1 FROM blobs WHERE id IN (${placeholders(part.length)})
         UNION ALL
         SELECT b.id, down.d + 1 FROM down JOIN blobs b INDEXED BY blobs_dir_name
           ON b.project_id = ? AND b.parent_id = down.id AND b.kind = 'dir' AND b.status = 'active'
         WHERE down.d <= ${MAX_DEPTH}
       )
       SELECT MAX(d) AS d FROM down`,
      ...part,
      projectId,
    );
    if (chain.length + (deepest?.d ?? 1) > MAX_DEPTH) throw tooDeep();
  }
}

/**
 * Moves and/or renames blobs of one project (≤ 100): `to` is the new directory ('' = root,
 * undefined = stay), `name` a new name (one blob only). One write per chunk of rows, whatever
 * the directories hold. A taken name fails the whole move with `name_taken`.
 */
export async function moveBlobs(db: DB, projectId: string, rows: BlobRow[], o: { to?: string; name?: string }) {
  const moving = o.to === undefined ? [] : rows.filter((r) => r.parent_id !== o.to);
  if (moving.length) await checkMove(db, projectId, moving, o.to!);
  const t = now();
  const stmts: Stmt[] = [];
  if (o.name !== undefined && rows.length === 1) {
    const r = rows[0];
    const to = o.to ?? r.parent_id;
    if (o.name === r.name && to === r.parent_id) return 0;
    stmts.push(stmt(db, "UPDATE blobs SET name = ?, parent_id = ?, updated_at = ? WHERE id = ? AND status = 'active'", o.name, to, t, r.id));
  } else {
    for (const ids of chunks(moving.map((r) => r.id)))
      stmts.push(
        stmt(db, `UPDATE blobs SET parent_id = ?, updated_at = ? WHERE status = 'active' AND id IN (${placeholders(ids.length)})`, o.to, t, ...ids),
      );
  }
  if (stmts.length === 0) return 0;
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isUniqueError(e)) throw nameTaken();
    throw e;
  }
  return stmts.length === 1 && o.name !== undefined ? 1 : moving.length;
}

/** Up to `limit` files below directory `root`, breadth first and by name, with their paths relative to it. */
export async function subtreeFiles(db: DB, projectId: string, root: string, limit: number, maxDirs = 200) {
  const out: { path: string; blob: BlobRow }[] = [];
  const queue: { id: string; path: string }[] = [{ id: root, path: "" }];
  for (let visited = 0; queue.length && out.length < limit && visited < maxDirs; visited++) {
    const d = queue.shift()!;
    const rows = await all<BlobRow>(
      db,
      `SELECT * FROM blobs INDEXED BY blobs_dir_name WHERE project_id = ? AND parent_id = ? AND status = 'active'
       ORDER BY kind, name COLLATE NOCASE, id LIMIT ?`,
      projectId,
      d.id,
      limit - out.length + 1000,
    );
    for (const r of rows) {
      if (r.kind === "dir") queue.push({ id: r.id, path: `${d.path}${r.name}/` });
      else if (out.length < limit) out.push({ path: d.path + r.name, blob: r });
    }
  }
  return out;
}

// ---- Deleting directories

const BATCH = 100;

/** Releases up to `budget` rows directly inside a deleted directory; removes its row once it is empty. */
async function drainDir(db: DB, d: { id: string; project_id: string; owner_id: string | null; project_status: string | null }, budget: number) {
  let spent = 0;
  const dirs: string[] = [];
  while (spent < budget) {
    const kids = await all<Pick<BlobRow, "id" | "size" | "kind">>(
      db,
      `SELECT id, size, kind FROM blobs INDEXED BY blobs_project_name WHERE project_id = ? AND parent_id = ? AND status = 'active' LIMIT ${BATCH}`,
      d.project_id,
      d.id,
    );
    if (kids.length === 0) {
      await run(db, "DELETE FROM blobs WHERE id = ? AND status = 'deleted'", d.id);
      return { spent: spent + 1, done: true, dirs };
    }
    // A project that is being deleted has released its usage already; GC flags its rows.
    if (d.project_status !== "active" || !d.owner_id) break;
    await deleteBlobs(db, { id: d.project_id, owner_id: d.owner_id }, kids);
    spent += kids.length;
    dirs.push(...kids.filter((k) => k.kind === "dir").map((k) => k.id));
  }
  return { spent, done: false, dirs };
}

const DELETED_DIRS = `
  SELECT b.id, b.project_id, p.owner_id, p.status AS project_status
  FROM blobs b INDEXED BY blobs_gc_dirs LEFT JOIN projects p ON p.id = b.project_id
  WHERE b.status = 'deleted' AND b.kind = 'dir'`;

/**
 * Releases the contents of deleted directories (files become deleted blobs for GC, usage is
 * given back, share links go) and removes directory rows that are empty, writing about `budget`
 * rows at most. With `ids` it works down from those directories (a request that just deleted
 * them); without, on the oldest deleted directories (GC). Returns the rows written.
 */
export async function drainDeletedDirs(db: DB, budget: number, ids?: string[]): Promise<number> {
  let spent = 0;
  if (ids) {
    const queue = [...ids];
    while (queue.length && spent < budget) {
      const part = queue.splice(0, 50);
      for (const d of await all<Parameters<typeof drainDir>[1]>(db, `${DELETED_DIRS} AND b.id IN (${placeholders(part.length)})`, ...part)) {
        if (spent >= budget) break;
        const r = await drainDir(db, d, budget - spent);
        spent += r.spent;
        queue.push(...r.dirs);
      }
    }
    return spent;
  }
  for (let round = 0; round < 100 && spent < budget; round++) {
    const before = spent;
    for (const d of await all<Parameters<typeof drainDir>[1]>(db, `${DELETED_DIRS} ORDER BY b.updated_at LIMIT 20`)) {
      if (spent >= budget) break;
      spent += (await drainDir(db, d, budget - spent)).spent;
    }
    if (spent === before) break;
  }
  return spent;
}
