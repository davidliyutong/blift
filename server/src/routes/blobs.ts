import { Hono } from "hono";
import { all, chunks, placeholders, run } from "../db";
import type { AppEnv, Ctx } from "../env";
import { badRequest, notFound } from "../lib/errors";
import { blobName, body, int } from "../lib/http";
import { BLOB_SORTS, deleteBlobs, listBlobs, loadBlob, loadProject, type BlobRow, type BlobSort, type ProjectRow } from "../services/projects";
import { chainOf, dirInfo, drainDeletedDirs, findPath, makeDirs, moveBlobs, requireDir, splitPath, walkPath, withPath, withPaths } from "../services/tree";
import { addStats } from "../services/stats";
import { storageFor } from "../services/storage";

export const DOWNLOAD_TTL = 3600;
/** Rows a request that deletes directories releases itself; larger directories are finished by GC. */
const DRAIN_ROWS = 300;

// Mounted at /api/projects/:pid/blobs
export const projectBlobs = new Hono<AppEnv>();

projectBlobs.get("/", async (c) => {
  const p = await loadProject(c, c.req.param("pid")!, "viewer");
  const db = c.env.DB;
  const sort = c.req.query("sort") ?? "created_at";
  const names = c.req.queries("name") ?? [];
  if (names.length > 50) throw badRequest("at most 50 names per request");
  const cursor = c.req.query("cursor") || undefined;
  const offset = int(c.req.query("offset") ?? 0, "offset", 0, 1e9);
  if (cursor && offset) throw badRequest("use either cursor or offset");

  // `parent_id` or `path` lists one directory; without them, all files of the project.
  const parentId = c.req.query("parent_id");
  const path = c.req.query("path");
  let chain: Awaited<ReturnType<typeof chainOf>> | undefined;
  if (parentId !== undefined && parentId !== "") {
    chain = await chainOf(db, await requireDir(db, p.id, parentId));
  } else if (path !== undefined || parentId !== undefined) {
    const segs = splitPath(path);
    const rows = await walkPath(db, p.id, segs);
    if (rows.length !== segs.length || rows.some((r) => r.kind !== "dir")) throw notFound("directory");
    chain = rows.map(({ id, name }) => ({ id, name }));
  }
  if (chain && offset) throw badRequest("directory listings page with cursor");

  const page = await listBlobs(db, p, {
    sort: (BLOB_SORTS as readonly string[]).includes(sort) ? (sort as BlobSort) : "created_at",
    order: c.req.query("order") === "asc" ? "asc" : "desc",
    limit: int(c.req.query("limit") ?? 100, "limit", 1, 1000),
    dir: chain && (chain.length ? chain[chain.length - 1].id : ""),
    q: (c.req.query("q") ?? "").trim() || undefined,
    prefix: c.req.query("prefix") || undefined,
    names,
    cursor,
    offset,
  });
  return c.json({
    ...(chain ? { dir: dirInfo(chain) } : {}),
    blobs: await withPaths(db, page.rows),
    total: page.total,
    next_cursor: page.next_cursor,
  });
});

/** The active blobs of a project among `ids` (1–100). */
async function blobsByIds(c: Ctx, projectId: string, ids: unknown): Promise<BlobRow[]> {
  // ≤ 100 per request keeps each write short; clients send larger sets in batches.
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) throw badRequest("ids must be an array of 1-100 ids");
  const found: BlobRow[] = [];
  for (const part of chunks(ids.map(String))) {
    found.push(
      ...(await all<BlobRow>(
        c.env.DB,
        `SELECT * FROM blobs WHERE project_id = ? AND status = 'active' AND id IN (${placeholders(part.length)})`,
        projectId,
        ...part,
      )),
    );
  }
  return found;
}

/** Deletes blobs; what deleted directories held is released here as far as DRAIN_ROWS goes, the rest by GC. */
async function remove(c: Ctx, p: ProjectRow, rows: BlobRow[]) {
  const n = await deleteBlobs(c.env.DB, p, rows);
  const dirs = rows.filter((r) => r.kind === "dir").map((r) => r.id);
  if (dirs.length) await drainDeletedDirs(c.env.DB, DRAIN_ROWS, dirs);
  return n;
}

projectBlobs.post("/delete", async (c) => {
  const p = await loadProject(c, c.req.param("pid")!, "editor");
  return c.json({ deleted: await remove(c, p, await blobsByIds(c, p.id, (await body(c)).ids)) });
});

projectBlobs.post("/move", async (c) => {
  const p = await loadProject(c, c.req.param("pid")!, "editor");
  const b = await body(c);
  const to = await requireDir(c.env.DB, p.id, b.parent_id);
  return c.json({ moved: await moveBlobs(c.env.DB, p.id, await blobsByIds(c, p.id, b.ids), { to }) });
});

// Mounted at /api/projects/:pid/dirs
export const projectDirs = new Hono<AppEnv>();

projectDirs.post("/", async (c) => {
  const p = await loadProject(c, c.req.param("pid")!, "editor");
  const b = await body(c);
  const from = await requireDir(c.env.DB, p.id, b.parent_id);
  const { dir, created } = await makeDirs(c.env.DB, p.id, from, splitPath(b.path), { parents: b.parents === true, userId: c.get("user")!.id });
  return c.json(await withPath(c.env.DB, (await loadBlob(c, dir.id, "viewer")).blob), created ? 201 : 200);
});

// Mounted at /api/projects/:pid/stat
export const projectStat = new Hono<AppEnv>();

projectStat.get("/", async (c) => {
  const p = await loadProject(c, c.req.param("pid")!, "viewer");
  const found = await findPath(c.env.DB, p.id, splitPath(c.req.query("path")));
  if (!found) throw notFound("file");
  return c.json(await withPath(c.env.DB, (await loadBlob(c, found.id, "viewer")).blob));
});

// Mounted at /api/blobs
export const blobs = new Hono<AppEnv>();

blobs.get("/:id", async (c) => c.json(await withPath(c.env.DB, (await loadBlob(c, c.req.param("id"), "viewer")).blob)));

// Rename and/or move. A directory moves with everything in it.
blobs.patch("/:id", async (c) => {
  const { blob, project } = await loadBlob(c, c.req.param("id"), "editor");
  const b = await body(c);
  const name = b.name === undefined ? undefined : blobName(b.name);
  const to = b.parent_id === undefined ? undefined : await requireDir(c.env.DB, project.id, b.parent_id);
  if (name !== undefined || to !== undefined) await moveBlobs(c.env.DB, project.id, [blob], { to, name });
  return c.json(await withPath(c.env.DB, (await loadBlob(c, blob.id, "viewer")).blob));
});

blobs.delete("/:id", async (c) => {
  const { blob, project } = await loadBlob(c, c.req.param("id"), "editor");
  await remove(c, project, [blob]);
  return c.body(null, 204);
});

blobs.get("/:id/download", async (c) => {
  const { blob } = await loadBlob(c, c.req.param("id"), "viewer");
  if (blob.kind !== "file") throw badRequest("a directory cannot be downloaded");
  const { s3 } = await storageFor(c.env, blob.storage_id);
  const url = await s3.presignGet(blob.object_key, DOWNLOAD_TTL, blob.name, {
    inline: c.req.query("inline") === "1",
    contentType: blob.content_type,
  });
  addStats(c, { downloads: 1, download_bytes: blob.size });
  c.executionCtx.waitUntil(run(c.env.DB, "UPDATE blobs SET download_count = download_count + 1 WHERE id = ?", blob.id));
  if (c.req.query("redirect") === "1") return c.redirect(url, 302);
  return c.json({ url, expires_at: Date.now() + DOWNLOAD_TTL * 1000 });
});
