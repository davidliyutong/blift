import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { JWTPayload } from "jose";
import { isSecure, requireUser } from "../auth";
import { all, now, one, run } from "../db";
import type { AppEnv, Ctx } from "../env";
import { hashPassword, verifyPassword } from "../lib/crypto";
import { ApiError, badRequest, forbidden, notFound } from "../lib/errors";
import { body, int, isLinkPreview, publicOrigin, str, wantsPage } from "../lib/http";
import { newId, newShareToken } from "../lib/ids";
import { signJwt, verifyJwt } from "../lib/jwt";
import { contentDisposition } from "../lib/s3";
import { BLOB_SELECT, listBlobs, loadProject, type BlobRow } from "../services/projects";
import { addStats } from "../services/stats";
import { storageFor } from "../services/storage";
import { userRef } from "../services/users";
import { DOWNLOAD_TTL } from "./blobs";
import { abortUpload, finishUpload, partUrls, startUpload, UPLOAD_TTL, uploadRequest } from "./uploads";

type ShareRow = {
  id: string;
  token: string;
  /** 'upload' = an inbox: anonymous uploads into the project, nothing to download. */
  mode: "download" | "upload";
  project_id: string;
  blob_id: string | null;
  creator_id: string;
  password_hash: string | null;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  max_uploads: number | null;
  max_upload_bytes: number | null;
  upload_count: number;
  upload_bytes: number;
  view_count: number;
  created_at: number;
  project_name: string;
  project_description: string;
  project_storage_id: string;
  owner_id: string;
  owner_status: string | null;
  project_blob_count: number;
  project_used_bytes: number;
  blob_name: string | null;
  blob_size: number | null;
  creator_username: string | null;
  creator_display_name: string | null;
};

const SHARE_SELECT = `
  SELECT s.*, p.name AS project_name, p.description AS project_description, p.storage_id AS project_storage_id,
         p.owner_id, p.blob_count AS project_blob_count, p.used_bytes AS project_used_bytes, o.status AS owner_status,
         b.name AS blob_name, b.size AS blob_size,
         u.username AS creator_username, u.display_name AS creator_display_name
  FROM shares s
  JOIN projects p ON p.id = s.project_id AND p.status = 'active'
  LEFT JOIN users o ON o.id = p.owner_id
  LEFT JOIN blobs b ON b.id = s.blob_id
  LEFT JOIN users u ON u.id = s.creator_id`;

/** A file's direct link (/s/<token>/<name>): `wget <link>` saves it under its own name. */
export const directLink = (origin: string, token: string, name: string) => `${origin}/s/${token}/${encodeURIComponent(name)}`;

const toShare = (c: Ctx, s: ShareRow) => ({
  id: s.id,
  token: s.token,
  url: `${publicOrigin(c)}/s/${s.token}`,
  mode: s.mode,
  project_id: s.project_id,
  project_name: s.project_name,
  blob_id: s.blob_id,
  blob_name: s.blob_name,
  download_url: s.blob_id && s.blob_name ? directLink(publicOrigin(c), s.token, s.blob_name) : null,
  has_password: !!s.password_hash,
  expires_at: s.expires_at,
  max_downloads: s.max_downloads,
  download_count: s.download_count,
  max_uploads: s.max_uploads,
  max_upload_bytes: s.max_upload_bytes,
  upload_count: s.upload_count,
  upload_bytes: s.upload_bytes,
  view_count: s.view_count,
  creator: userRef(s.creator_id, s.creator_username, s.creator_display_name),
  created_at: s.created_at,
});

// ---- Management (/api/shares)

export const shares = new Hono<AppEnv>();

shares.get("/", async (c) => {
  const u = requireUser(c);
  const projectId = c.req.query("project_id");
  const rows = projectId
    ? await all<ShareRow>(c.env.DB, `${SHARE_SELECT} WHERE s.project_id = ? ORDER BY s.created_at DESC LIMIT 1000`, (await loadProject(c, projectId, "viewer")).id)
    : await all<ShareRow>(
        c.env.DB,
        `${SHARE_SELECT} WHERE s.creator_id = ? OR p.owner_id = ? ORDER BY s.created_at DESC LIMIT 1000`,
        u.id,
        u.id,
      );
  return c.json({ shares: rows.map((s) => toShare(c, s)) });
});

shares.post("/", async (c) => {
  const u = requireUser(c);
  const b = await body(c);
  const p = await loadProject(c, str(b.project_id, "project_id", 64), "editor");
  const mode = b.mode ?? "download";
  if (mode !== "download" && mode !== "upload") throw badRequest('mode must be "download" or "upload"');
  const upload = mode === "upload";
  if (upload && b.blob_id) throw badRequest("upload links cover a whole project");
  let blobId: string | null = null;
  if (b.blob_id) {
    const blob = await one<{ id: string }>(c.env.DB, "SELECT id FROM blobs WHERE id = ? AND project_id = ? AND status = 'active'", b.blob_id, p.id);
    if (!blob) throw notFound("file");
    blobId = blob.id;
  }
  const pw = b.password ? String(b.password) : "";
  if (pw && (pw.length < 4 || pw.length > 128)) throw badRequest("password must be 4-128 characters");
  const expiresIn = b.expires_in == null ? null : int(b.expires_in, "expires_in", 60, 3650 * 86400);
  // Each mode keeps only its own limits.
  const limit = (v: unknown, field: string, max: number, applies: boolean) => (!applies || v == null ? null : int(v, field, 1, max));
  const maxDownloads = limit(b.max_downloads, "max_downloads", 1_000_000, !upload);
  const maxUploads = limit(b.max_uploads, "max_uploads", 1_000_000, upload);
  const maxUploadBytes = limit(b.max_upload_bytes, "max_upload_bytes", Number.MAX_SAFE_INTEGER, upload);

  const id = newId();
  await run(
    c.env.DB,
    `INSERT INTO shares (id, token, mode, project_id, blob_id, creator_id, password_hash, expires_at, max_downloads, max_uploads, max_upload_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    newShareToken(),
    mode,
    p.id,
    blobId,
    u.id,
    pw ? await hashPassword(pw) : null,
    expiresIn ? now() + expiresIn * 1000 : null,
    maxDownloads,
    maxUploads,
    maxUploadBytes,
    now(),
  );
  const row = await one<ShareRow>(c.env.DB, `${SHARE_SELECT} WHERE s.id = ?`, id);
  return c.json(toShare(c, row!), 201);
});

shares.delete("/:id", async (c) => {
  const u = requireUser(c);
  const s = await one<ShareRow>(c.env.DB, `${SHARE_SELECT} WHERE s.id = ?`, c.req.param("id"));
  if (!s) throw notFound("share");
  if (s.creator_id !== u.id && s.owner_id !== u.id && u.role !== "admin") throw forbidden();
  await run(c.env.DB, "DELETE FROM shares WHERE id = ?", s.id);
  return c.body(null, 204);
});

// ---- Public access (/api/public/shares), no login

export const publicShares = new Hono<AppEnv>();

const ACCESS_TTL = 86400;
const accessCookie = (token: string) => `blift_share_${token}`;

const uploadsUsedUp = (s: ShareRow) =>
  (s.max_uploads != null && s.upload_count >= s.max_uploads) || (s.max_upload_bytes != null && s.upload_bytes >= s.max_upload_bytes);

async function loadShare(c: Ctx, token: string): Promise<ShareRow> {
  const s = await one<ShareRow>(c.env.DB, `${SHARE_SELECT} WHERE s.token = ?`, token);
  if (!s || (s.blob_id && !s.blob_name)) throw notFound("share");
  // An upload link of a disabled owner takes nothing.
  if (s.mode === "upload" && s.owner_status !== "active") throw notFound("share");
  if (s.expires_at && s.expires_at < now()) throw new ApiError(410, "share_expired", "this share has expired");
  if (s.mode === "download" && s.max_downloads != null && s.download_count >= s.max_downloads)
    throw new ApiError(410, "share_exhausted", "this share reached its download limit");
  if (s.mode === "upload" && uploadsUsedUp(s)) throw new ApiError(410, "share_exhausted", "this upload link reached its limit");
  return s;
}

async function isUnlocked(c: Ctx, s: ShareRow): Promise<boolean> {
  if (!s.password_hash) return true;
  const t = c.req.header("x-share-access") ?? c.req.query("access_token") ?? getCookie(c, accessCookie(s.token));
  const claims = await verifyJwt<JWTPayload & { typ?: string }>(c.env.APP_SECRET, t);
  return claims?.sub === s.id && claims.typ === "share";
}

// Project shares list their files a page at a time (by name; `cursor` continues).
publicShares.get("/:token", async (c) => {
  const s = await loadShare(c, c.req.param("token"));
  const unlocked = await isUnlocked(c, s);
  const cursor = c.req.query("cursor") || undefined;
  if (!cursor) c.executionCtx.waitUntil(run(c.env.DB, "UPDATE shares SET view_count = view_count + 1 WHERE id = ?", s.id));
  if (s.mode === "upload") {
    // Uploaders learn where their files go and how much the link still takes, nothing else.
    return c.json({
      share: {
        token: s.token,
        mode: s.mode,
        kind: "project",
        name: s.project_name,
        description: s.project_description,
        has_password: !!s.password_hash,
        locked: !unlocked,
        expires_at: s.expires_at,
        max_uploads: s.max_uploads,
        upload_count: s.upload_count,
        max_upload_bytes: s.max_upload_bytes,
        upload_bytes: s.upload_bytes,
        creator: s.creator_display_name || s.creator_username || "",
        created_at: s.created_at,
      },
    });
  }
  let blobs: Pick<BlobRow, "id" | "name" | "size" | "content_type" | "created_at">[] | undefined;
  let nextCursor: string | null = null;
  if (unlocked && s.blob_id) {
    blobs = await all(c.env.DB, "SELECT id, name, size, content_type, created_at FROM blobs WHERE id = ? AND status = 'active'", s.blob_id);
  } else if (unlocked) {
    const page = await listBlobs(
      c.env.DB,
      { id: s.project_id, blob_count: s.project_blob_count },
      { sort: "name", order: "asc", limit: int(c.req.query("limit") ?? 5000, "limit", 1, 5000), cursor },
    );
    blobs = page.rows.map(({ id, name, size, content_type, created_at }) => ({ id, name, size, content_type, created_at }));
    nextCursor = page.next_cursor;
  }
  return c.json({
    share: {
      token: s.token,
      mode: s.mode,
      kind: s.blob_id ? "blob" : "project",
      name: s.blob_name ?? s.project_name,
      has_password: !!s.password_hash,
      locked: !unlocked,
      expires_at: s.expires_at,
      max_downloads: s.max_downloads,
      download_count: s.download_count,
      creator: s.creator_display_name || s.creator_username || "",
      created_at: s.created_at,
      file_count: s.blob_id ? 1 : s.project_blob_count,
      total_bytes: s.blob_id ? (s.blob_size ?? 0) : s.project_used_bytes,
    },
    ...(blobs ? { blobs, next_cursor: nextCursor } : {}),
  });
});

publicShares.post("/:token/unlock", async (c) => {
  const s = await loadShare(c, c.req.param("token"));
  const pw = String((await body(c)).password ?? "");
  if (s.password_hash && !(await verifyPassword(pw, s.password_hash)))
    throw new ApiError(403, "invalid_password", "wrong password");
  const access = await signJwt(c.env.APP_SECRET, { sub: s.id, typ: "share" }, ACCESS_TTL);
  setCookie(c, accessCookie(s.token), access, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: `/api/public/shares/${s.token}`,
    maxAge: ACCESS_TTL,
  });
  return c.json({ access_token: access });
});

/** The shared file a download asks for, by id or by name; 404 when the share does not cover it. */
async function shareBlob(c: Ctx, s: ShareRow, by: { id: string } | { name: string }): Promise<BlobRow> {
  if (s.mode !== "download") throw notFound("file");
  const blob =
    "id" in by
      ? await one<BlobRow>(c.env.DB, "SELECT * FROM blobs WHERE id = ? AND project_id = ? AND status = 'active'", by.id, s.project_id)
      : await one<BlobRow>(c.env.DB, "SELECT * FROM blobs WHERE project_id = ? AND name = ? AND status = 'active'", s.project_id, by.name);
  if (!blob || (s.blob_id && s.blob_id !== blob.id)) throw notFound("file");
  return blob;
}

/** Counts one download of a shared file and returns a presigned URL for it. */
async function shareDownload(c: Ctx, s: ShareRow, blob: BlobRow): Promise<string> {
  // Count first; the WHERE clause enforces max_downloads atomically.
  const ok = await run(
    c.env.DB,
    "UPDATE shares SET download_count = download_count + 1 WHERE id = ? AND (max_downloads IS NULL OR download_count < max_downloads)",
    s.id,
  );
  if (!ok) throw new ApiError(410, "share_exhausted", "this share reached its download limit");

  const { s3 } = await storageFor(c.env, blob.storage_id);
  const url = await s3.presignGet(blob.object_key, DOWNLOAD_TTL, blob.name);
  c.set("statsUser", s.owner_id);
  addStats(c, { downloads: 1, download_bytes: blob.size });
  c.executionCtx.waitUntil(run(c.env.DB, "UPDATE blobs SET download_count = download_count + 1 WHERE id = ?", blob.id));
  return url;
}

publicShares.get("/:token/blobs/:blobId/download", async (c) => {
  const s = await loadShare(c, c.req.param("token"));
  if (!(await isUnlocked(c, s))) throw new ApiError(403, "invalid_password", "password required");
  const url = await shareDownload(c, s, await shareBlob(c, s, { id: c.req.param("blobId") }));
  if (c.req.query("redirect") === "1") return c.redirect(url, 302);
  return c.json({ url, expires_at: now() + DOWNLOAD_TTL * 1000 });
});

// ---- Direct links for wget, curl and scripts: /s/<token> and /s/<token>/<name> (aliases, see
// app.ts). A file redirects to a presigned URL, counted like any share download; a project share
// without a name lists one direct link per file. Answers are text/plain, errors too.

/** Direct links a project share lists at /s/<token> (its first files by name). */
export const DIRECT_LIST_LIMIT = 1000;

publicShares.get("/:token/direct/:name?", async (c) => {
  const token = c.req.param("token");
  const name = c.req.param("name");
  const origin = publicOrigin(c);
  const page = `${origin}/s/${encodeURIComponent(token)}`;
  // A chat app previewing /s/<token>/<name> gets the share page rather than using up a download.
  if (isLinkPreview(c.req.raw)) return c.redirect(page, 302);
  try {
    const s = await loadShare(c, token);
    if (s.mode === "upload") throw new ApiError(404, "not_found", `this is an upload link; open ${page} in a browser`);
    if (!(await isUnlocked(c, s)))
      throw new ApiError(403, "invalid_password", `this share is password protected; open ${page} in a browser`);
    if (name === undefined && !s.blob_id) {
      const files = await listBlobs(
        c.env.DB,
        { id: s.project_id, blob_count: s.project_blob_count },
        { sort: "name", order: "asc", limit: DIRECT_LIST_LIMIT },
      );
      const access = c.req.query("access_token");
      const suffix = access ? `?access_token=${encodeURIComponent(access)}` : "";
      c.executionCtx.waitUntil(run(c.env.DB, "UPDATE shares SET view_count = view_count + 1 WHERE id = ?", s.id));
      return c.text(files.rows.map((b) => `${directLink(origin, s.token, b.name)}${suffix}\n`).join(""));
    }
    const blob = await shareBlob(c, s, name === undefined ? { id: s.blob_id! } : { name: name.normalize("NFC") });
    // HEAD describes the file without counting a download (wget asks first with some options).
    if (c.req.method === "HEAD")
      return c.body(null, 200, {
        "content-type": blob.content_type,
        "content-length": String(blob.size),
        "content-disposition": contentDisposition(blob.name),
      });
    return c.redirect(await shareDownload(c, s, blob), 302);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // A browser that followed a direct link sees the problem (or the password prompt) on the page.
    if (wantsPage(c.req.raw)) return c.redirect(page, 302);
    return c.text(`${e.message} (${e.code})\n`, e.status as 404);
  }
});

// ---- Upload links (mode 'upload'): anonymous uploads into the share's project. Uploaders can
// only add files: nothing is listed, downloaded or replaced (a taken name becomes "name (1).ext").
// Bytes go straight to S3 like every other upload; usage and stats are charged to the project
// owner. Each init hands out an upload token (a JWT for that one pending blob of that link), which
// the later calls (parts, complete, abort) send as X-Upload-Token; they work while the link exists,
// so an upload that has started can finish after the link expires.

/** The pending upload named by the URL, if the upload token is for it and its link. */
async function loadUpload(c: Ctx) {
  const s = await one<ShareRow>(c.env.DB, `${SHARE_SELECT} WHERE s.token = ? AND s.mode = 'upload'`, c.req.param("token"));
  const blobId = c.req.param("blobId");
  const claims = await verifyJwt<JWTPayload & { typ?: string; sid?: string }>(c.env.APP_SECRET, c.req.header("x-upload-token"));
  if (!s || claims?.typ !== "upload" || claims.sid !== s.id || claims.sub !== blobId) throw notFound("upload");
  const blob = await one<BlobRow>(c.env.DB, `${BLOB_SELECT} WHERE b.id = ? AND b.project_id = ? AND b.status = 'pending'`, blobId, s.project_id);
  if (!blob) throw notFound("upload");
  c.set("statsUser", s.owner_id);
  return { s, blob };
}

publicShares.post("/:token/uploads", async (c) => {
  const s = await loadShare(c, c.req.param("token"));
  if (s.mode !== "upload") throw notFound("share");
  if (!(await isUnlocked(c, s))) throw new ApiError(403, "invalid_password", "password required");
  const req = uploadRequest(await body(c));
  if (s.max_upload_bytes != null && s.upload_bytes + req.size > s.max_upload_bytes)
    throw new ApiError(413, "upload_too_large", "the file is larger than what this upload link can still take");
  c.set("statsUser", s.owner_id);
  const project = { id: s.project_id, owner_id: s.owner_id, storage_id: s.project_storage_id };
  const init = await startUpload(c, project, { ...req, overwrite: false, uploaderId: null, viaInbox: true });
  const upload_token = await signJwt(c.env.APP_SECRET, { sub: init.blob_id, sid: s.id, typ: "upload" }, UPLOAD_TTL);
  return c.json({ ...init, upload_token }, 201);
});

publicShares.post("/:token/uploads/:blobId/parts", async (c) => {
  const { blob } = await loadUpload(c);
  return c.json(await partUrls(c, blob, (await body<{ part_numbers?: unknown }>(c)).part_numbers));
});

publicShares.post("/:token/uploads/:blobId/complete", async (c) => {
  const { s, blob } = await loadUpload(c);
  const given = ((await c.req.json().catch(() => ({}))) as { parts?: unknown }).parts;
  // Count the file first: the WHERE clause keeps the link within its limits when uploads race.
  const counted = await run(
    c.env.DB,
    `UPDATE shares SET upload_count = upload_count + 1, upload_bytes = upload_bytes + ?
     WHERE id = ? AND (max_uploads IS NULL OR upload_count < max_uploads) AND (max_upload_bytes IS NULL OR upload_bytes + ? <= max_upload_bytes)`,
    blob.size,
    s.id,
    blob.size,
  );
  if (!counted) {
    await abortUpload(c, blob);
    throw new ApiError(410, "share_exhausted", "this upload link reached its limit");
  }
  try {
    const name = await finishUpload(c, blob, { id: s.project_id, owner_id: s.owner_id }, given);
    return c.json({ name, size: blob.size });
  } catch (e) {
    // Not stored (yet): give the file's share of the limits back.
    await run(c.env.DB, "UPDATE shares SET upload_count = upload_count - 1, upload_bytes = upload_bytes - ? WHERE id = ?", blob.size, s.id);
    throw e;
  }
});

publicShares.delete("/:token/uploads/:blobId", async (c) => {
  const { blob } = await loadUpload(c);
  await abortUpload(c, blob);
  return c.body(null, 204);
});
