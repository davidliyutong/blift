import { Hono } from "hono";
import { all, chunks, one, placeholders, run } from "../db";
import type { AppEnv } from "../env";
import { badRequest, conflict } from "../lib/errors";
import { blobName, body, int } from "../lib/http";
import { BLOB_SORTS, deleteBlobs, listBlobs, loadBlob, loadProject, toBlob, type BlobSort } from "../services/projects";
import { addStats } from "../services/stats";
import { storageFor } from "../services/storage";

export const DOWNLOAD_TTL = 3600;

// Mounted at /api/projects/:pid/blobs
export const projectBlobs = new Hono<AppEnv>();

projectBlobs.get("/", async (c) => {
  const p = await loadProject(c, c.req.param("pid")!, "viewer");
  const sort = c.req.query("sort") ?? "created_at";
  const names = c.req.queries("name") ?? [];
  if (names.length > 50) throw badRequest("at most 50 names per request");
  const cursor = c.req.query("cursor") || undefined;
  const offset = int(c.req.query("offset") ?? 0, "offset", 0, 1e9);
  if (cursor && offset) throw badRequest("use either cursor or offset");
  const page = await listBlobs(c.env.DB, p, {
    sort: (BLOB_SORTS as readonly string[]).includes(sort) ? (sort as BlobSort) : "created_at",
    order: c.req.query("order") === "asc" ? "asc" : "desc",
    limit: int(c.req.query("limit") ?? 100, "limit", 1, 1000),
    q: (c.req.query("q") ?? "").trim() || undefined,
    prefix: c.req.query("prefix") || undefined,
    names,
    cursor,
    offset,
  });
  return c.json({ blobs: page.rows.map(toBlob), total: page.total, next_cursor: page.next_cursor });
});

projectBlobs.post("/delete", async (c) => {
  const p = await loadProject(c, c.req.param("pid")!, "editor");
  const ids = (await body<{ ids?: unknown }>(c)).ids;
  // ≤ 100 per request keeps each delete a short write; clients send larger sets in batches.
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) throw badRequest("ids must be an array of 1-100 ids");
  const found: { id: string; size: number }[] = [];
  for (const part of chunks(ids.map(String))) {
    found.push(
      ...(await all<{ id: string; size: number }>(
        c.env.DB,
        `SELECT id, size FROM blobs WHERE project_id = ? AND status = 'active' AND id IN (${placeholders(part.length)})`,
        p.id,
        ...part,
      )),
    );
  }
  return c.json({ deleted: await deleteBlobs(c.env.DB, p, found) });
});

// Mounted at /api/blobs
export const blobs = new Hono<AppEnv>();

blobs.get("/:id", async (c) => c.json(toBlob((await loadBlob(c, c.req.param("id"), "viewer")).blob)));

blobs.patch("/:id", async (c) => {
  const { blob } = await loadBlob(c, c.req.param("id"), "editor");
  const name = blobName((await body(c)).name);
  if (name !== blob.name) {
    if (await one(c.env.DB, "SELECT 1 AS x FROM blobs WHERE project_id = ? AND name = ? AND status = 'active'", blob.project_id, name))
      throw conflict("name_taken", "a file with this name already exists");
    await run(c.env.DB, "UPDATE blobs SET name = ?, updated_at = ? WHERE id = ?", name, Date.now(), blob.id);
  }
  return c.json(toBlob((await loadBlob(c, blob.id, "viewer")).blob));
});

blobs.delete("/:id", async (c) => {
  const { blob, project } = await loadBlob(c, c.req.param("id"), "editor");
  await deleteBlobs(c.env.DB, project, [blob]);
  return c.body(null, 204);
});

blobs.get("/:id/download", async (c) => {
  const { blob } = await loadBlob(c, c.req.param("id"), "viewer");
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
