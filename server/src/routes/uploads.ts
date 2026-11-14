// Direct-to-S3 uploads. The Worker only signs URLs and bookkeeps; file bytes never pass
// through it (Workers cap request bodies at 100 MB and CPU time is precious).
//
//   init  → pending blob row (+ CreateMultipartUpload for big files)
//   parts → presigned UploadPart URLs (pure crypto, no subrequests)
//   complete → CompleteMultipartUpload + HEAD to verify size → blob becomes active
//
// Pending blobs that are never completed are swept by GC (services/gc.ts).
import { Hono } from "hono";
import { all, now, one, placeholders, run, stmt, type DB, type Stmt } from "../db";
import type { AppEnv, Ctx, UserRow } from "../env";
import { ApiError, badRequest, conflict } from "../lib/errors";
import { blobName, body, int, optStr } from "../lib/http";
import { newId, randomString } from "../lib/ids";
import type { Part } from "../lib/s3";
import { loadBlob, loadProject, toBlob, type BlobRow, type ProjectRow } from "../services/projects";
import { getSettings } from "../services/settings";
import { addStats } from "../services/stats";
import { objectKey, storageFor } from "../services/storage";
import { hasQuotaFor } from "../services/users";

const MiB = 1024 ** 2;
export const SINGLE_MAX = 64 * MiB;
const MIN_PART = 16 * MiB;
const MAX_PARTS = 10_000;
const MAX_SIZE = 5 * 1024 ** 4; // 5 TiB, the S3 object limit
export const UPLOAD_TTL = 6 * 3600;

/** Fixed part size (R2 requires equal parts), a whole number of MiB, ≤ 10 000 parts. */
export const partSizeFor = (size: number) => Math.max(MIN_PART, Math.ceil(size / MAX_PARTS / MiB) * MiB);

const nameTaken = () => conflict("name_taken", "a file with this name already exists");

type UploadOpts = { name: string; size: number; contentType: string; overwrite: boolean; uploaderId: string | null; viaInbox: boolean };

/** Validates an init request body ({name, size, content_type, overwrite}). */
export function uploadRequest(b: Record<string, unknown>) {
  return {
    name: blobName(b.name),
    size: int(b.size, "size", 0, MAX_SIZE),
    contentType: optStr(b.content_type, "content_type", 255) ?? "application/octet-stream",
    overwrite: b.overwrite === true,
  };
}

/** init: checks name and quota, creates the pending blob (+ multipart upload) and signs the PUT. */
export async function startUpload(c: Ctx, p: Pick<ProjectRow, "id" | "owner_id" | "storage_id">, o: UploadOpts) {
  if (!o.overwrite && !o.viaInbox && (await one(c.env.DB, "SELECT 1 AS x FROM blobs WHERE project_id = ? AND name = ? AND status = 'active'", p.id, o.name)))
    throw nameTaken();
  const owner = await one<UserRow>(c.env.DB, "SELECT * FROM users WHERE id = ?", p.owner_id);
  if (!owner || !hasQuotaFor(owner, await getSettings(c.env.DB), o.size))
    throw new ApiError(403, "quota_exceeded", "storage quota of the project owner exceeded");

  const { s3, row: storage } = await storageFor(c.env, p.storage_id);
  const id = newId();
  const key = objectKey(storage, p.id, id);
  const expires_at = now() + UPLOAD_TTL * 1000;
  const multipart = o.size > SINGLE_MAX;
  const partSize = multipart ? partSizeFor(o.size) : null;
  const uploadId = multipart ? await s3.createMultipart(key, o.contentType) : null;

  await run(
    c.env.DB,
    `INSERT INTO blobs (id, project_id, storage_id, object_key, name, size, content_type, status, upload_id, part_size, overwrite, uploader_id, via_inbox, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    p.id,
    storage.id,
    key,
    o.name,
    o.size,
    o.contentType,
    uploadId,
    partSize,
    o.overwrite,
    o.uploaderId,
    o.viaInbox,
    now(),
    now(),
  );

  if (!multipart) return { blob_id: id, mode: "single" as const, url: await s3.presign("PUT", key, UPLOAD_TTL), expires_at };
  return { blob_id: id, mode: "multipart" as const, part_size: partSize!, part_count: Math.ceil(o.size / partSize!), expires_at };
}

/** parts: presigned UploadPart URLs (pure crypto, no subrequests). */
export async function partUrls(c: Ctx, blob: BlobRow, nums: unknown) {
  if (!blob.upload_id || !blob.part_size) throw badRequest("not a multipart upload");
  const count = Math.ceil(blob.size / blob.part_size);
  if (!Array.isArray(nums) || nums.length === 0 || nums.length > 100) throw badRequest("part_numbers must contain 1-100 numbers");
  const { s3 } = await storageFor(c.env, blob.storage_id);
  const urls: Record<string, string> = {};
  for (const n of nums) {
    const pn = int(n, "part_number", 1, count);
    urls[pn] = await s3.presignPart(blob.object_key, blob.upload_id, pn, UPLOAD_TTL);
  }
  return { urls, expires_at: now() + UPLOAD_TTL * 1000 };
}

/**
 * "a.txt" → "a (1).txt", "a (2).txt", …: the first name no active file of the project uses.
 * Uploads through an upload link never replace a file; they take the next free name.
 */
export async function freeName(db: DB, projectId: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const numbered = (n: string) => `${stem.slice(0, Math.max(1, 255 - ext.length - n.length - 3))} (${n})${ext}`;
  const tries = [name, ...Array.from({ length: 20 }, (_, i) => numbered(String(i + 1)))];
  const taken = await all<{ name: string }>(
    db,
    `SELECT name FROM blobs INDEXED BY blobs_project_name WHERE project_id = ? AND status = 'active' AND name IN (${placeholders(tries.length)})`,
    projectId,
    ...tries,
  );
  const used = new Set(taken.map((r) => r.name));
  return tries.find((n) => !used.has(n)) ?? numbered(randomString(6));
}

/**
 * complete: CompleteMultipartUpload + HEAD to verify the size, then the blob becomes active.
 * Returns the final name (uploads through an upload link may have been renamed).
 */
export async function finishUpload(c: Ctx, blob: BlobRow, project: Pick<ProjectRow, "id" | "owner_id">, given?: unknown) {
  const { s3 } = await storageFor(c.env, blob.storage_id);
  const db = c.env.DB;
  const discard = () => run(db, "UPDATE blobs SET status = 'deleted', updated_at = ? WHERE id = ?", now(), blob.id);

  if (blob.upload_id) {
    const parts: Part[] = Array.isArray(given) && given.length
      ? given.map((p: Part) => ({ part_number: int(p.part_number, "part_number", 1, MAX_PARTS), etag: String(p.etag) }))
      : await s3.listParts(blob.object_key, blob.upload_id);
    const expected = Math.ceil(blob.size / blob.part_size!);
    if (parts.length !== expected) throw badRequest(`upload incomplete: ${parts.length}/${expected} parts uploaded`);
    await s3.completeMultipart(blob.object_key, blob.upload_id, parts);
  }

  const head = await s3.head(blob.object_key);
  if (!head) throw badRequest("upload incomplete: object not found in storage");
  if (head.size !== blob.size) {
    await discard();
    throw badRequest(`size mismatch: declared ${blob.size} bytes, stored ${head.size} bytes`);
  }

  let existing = await one<{ id: string; size: number }>(
    db,
    "SELECT id, size FROM blobs WHERE project_id = ? AND name = ? AND status = 'active'",
    blob.project_id,
    blob.name,
  );
  let name = blob.name;
  if (existing && blob.via_inbox) {
    name = await freeName(db, blob.project_id, blob.name);
    existing = null;
  } else if (existing && !blob.overwrite) {
    await discard();
    throw nameTaken();
  }

  const t = now();
  const delta = blob.size - (existing?.size ?? 0);
  const stmts: Stmt[] = [];
  if (existing) {
    // Replace: old version goes to GC, its share links follow the new version.
    stmts.push(
      stmt(db, "UPDATE blobs SET status = 'deleted', updated_at = ? WHERE id = ?", t, existing.id),
      stmt(db, "UPDATE shares SET blob_id = ? WHERE blob_id = ?", blob.id, existing.id),
    );
  }
  stmts.push(
    stmt(
      db,
      "UPDATE blobs SET status = 'active', name = ?, upload_id = NULL, created_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      name,
      t,
      t,
      blob.id,
    ),
    stmt(
      db,
      "UPDATE projects SET used_bytes = used_bytes + ?, blob_count = blob_count + ?, updated_at = ? WHERE id = ?",
      delta,
      existing ? 0 : 1,
      t,
      project.id,
    ),
    stmt(db, "UPDATE users SET used_bytes = MAX(0, used_bytes + ?) WHERE id = ?", delta, project.owner_id),
  );
  await db.batch(stmts);
  addStats(c, { uploads: 1, upload_bytes: blob.size });
  return name;
}

/** Abort: just mark it; GC aborts the multipart upload / deletes the object. */
export const abortUpload = (c: Ctx, blob: BlobRow) =>
  run(c.env.DB, "UPDATE blobs SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'pending'", now(), blob.id);

// Mounted at /api/projects/:pid/uploads
export const projectUploads = new Hono<AppEnv>();

projectUploads.post("/", async (c) => {
  const p = await loadProject(c, c.req.param("pid")!, "editor");
  const req = uploadRequest(await body(c));
  return c.json(await startUpload(c, p, { ...req, uploaderId: c.get("user")!.id, viaInbox: false }), 201);
});

// Mounted at /api/uploads
export const uploads = new Hono<AppEnv>();

uploads.post("/:id/parts", async (c) => {
  const { blob } = await loadBlob(c, c.req.param("id"), "editor", "pending");
  return c.json(await partUrls(c, blob, (await body<{ part_numbers?: unknown }>(c)).part_numbers));
});

uploads.post("/:id/complete", async (c) => {
  const { blob, project } = await loadBlob(c, c.req.param("id"), "editor", "pending");
  const given = ((await c.req.json().catch(() => ({}))) as { parts?: unknown }).parts;
  await finishUpload(c, blob, project, given);
  return c.json(toBlob((await loadBlob(c, blob.id, "viewer")).blob));
});

uploads.delete("/:id", async (c) => {
  const { blob } = await loadBlob(c, c.req.param("id"), "editor", "pending");
  await abortUpload(c, blob);
  return c.body(null, 204);
});
