// Project inboxes: anonymous upload links (<origin>/i/<token>), turned on per project by its
// owner. Uploaders can only add files: nothing is listed, downloaded or replaced (a taken name
// becomes "name (1).ext"). Bytes go straight to S3 like every other upload, and usage and stats
// are charged to the project owner.
//
// Each init hands out an upload token (a JWT for that one pending blob), which the later calls
// (parts, complete, abort) must send as X-Upload-Token.
import { Hono } from "hono";
import type { JWTPayload } from "jose";
import { one } from "../db";
import type { AppEnv, Ctx } from "../env";
import { notFound } from "../lib/errors";
import { body } from "../lib/http";
import { signJwt, verifyJwt } from "../lib/jwt";
import { BLOB_SELECT, type BlobRow, type ProjectRow } from "../services/projects";
import { abortUpload, finishUpload, partUrls, startUpload, UPLOAD_TTL, uploadRequest } from "./uploads";

type InboxRow = Pick<ProjectRow, "id" | "name" | "description" | "owner_id" | "storage_id" | "owner_username" | "owner_display_name">;

async function loadInbox(c: Ctx): Promise<InboxRow> {
  const p = await one<InboxRow>(
    c.env.DB,
    `SELECT p.id, p.name, p.description, p.owner_id, p.storage_id, o.username AS owner_username, o.display_name AS owner_display_name
     FROM projects p LEFT JOIN users o ON o.id = p.owner_id
     WHERE p.inbox_token = ? AND p.status = 'active' AND o.status = 'active'`,
    c.req.param("token"),
  );
  if (!p) throw notFound("inbox");
  c.set("statsUser", p.owner_id);
  return p;
}

/** The pending blob of this inbox named by the URL, if the upload token is for it. */
async function loadUpload(c: Ctx) {
  const project = await loadInbox(c);
  const blobId = c.req.param("blobId");
  const claims = await verifyJwt<JWTPayload & { typ?: string }>(c.env.APP_SECRET, c.req.header("x-upload-token"));
  if (claims?.typ !== "inbox" || claims.sub !== blobId) throw notFound("upload");
  const blob = await one<BlobRow>(c.env.DB, `${BLOB_SELECT} WHERE b.id = ? AND b.project_id = ? AND b.status = 'pending'`, blobId, project.id);
  if (!blob) throw notFound("upload");
  return { blob, project };
}

// Mounted at /api/public/inbox
export const inbox = new Hono<AppEnv>();

inbox.get("/:token", async (c) => {
  const p = await loadInbox(c);
  return c.json({ inbox: { name: p.name, description: p.description, owner: p.owner_display_name || p.owner_username || "" } });
});

inbox.post("/:token/uploads", async (c) => {
  const p = await loadInbox(c);
  const req = uploadRequest(await body(c));
  const init = await startUpload(c, p, { ...req, overwrite: false, uploaderId: null, viaInbox: true });
  const upload_token = await signJwt(c.env.APP_SECRET, { sub: init.blob_id, typ: "inbox" }, UPLOAD_TTL);
  return c.json({ ...init, upload_token }, 201);
});

inbox.post("/:token/uploads/:blobId/parts", async (c) => {
  const { blob } = await loadUpload(c);
  return c.json(await partUrls(c, blob, (await body<{ part_numbers?: unknown }>(c)).part_numbers));
});

inbox.post("/:token/uploads/:blobId/complete", async (c) => {
  const { blob, project } = await loadUpload(c);
  const given = ((await c.req.json().catch(() => ({}))) as { parts?: unknown }).parts;
  const name = await finishUpload(c, blob, project, given);
  return c.json({ name, size: blob.size });
});

inbox.delete("/:token/uploads/:blobId", async (c) => {
  const { blob } = await loadUpload(c);
  await abortUpload(c, blob);
  return c.body(null, 204);
});
