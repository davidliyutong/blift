import { requireUser } from "../auth";
import { chunks, now, one, placeholders, stmt, type DB, type Stmt } from "../db";
import type { Ctx } from "../env";
import { forbidden, notFound } from "../lib/errors";
import { userRef } from "./users";

export type MemberRole = "owner" | "editor" | "viewer";
const RANK: Record<MemberRole, number> = { viewer: 1, editor: 2, owner: 3 };

export type ProjectRow = {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  storage_id: string;
  used_bytes: number;
  blob_count: number;
  status: "active" | "deleting";
  created_at: number;
  updated_at: number;
  owner_username: string | null;
  owner_display_name: string | null;
  storage_name: string | null;
  role: MemberRole;
};

/** SELECT list producing a ProjectRow; bind the caller's user id first. */
export const PROJECT_SELECT = `
  SELECT p.*, m.role AS role, o.username AS owner_username, o.display_name AS owner_display_name, st.name AS storage_name
  FROM projects p
  LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
  LEFT JOIN users o ON o.id = p.owner_id
  LEFT JOIN storages st ON st.id = p.storage_id`;

export function toProject(p: ProjectRow) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    owner: userRef(p.owner_id, p.owner_username, p.owner_display_name),
    role: p.role,
    storage_id: p.storage_id,
    storage_name: p.storage_name ?? "",
    used_bytes: p.used_bytes,
    blob_count: p.blob_count,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

/**
 * Loads an active project the caller can access with at least `need`.
 * Admins implicitly act as owners of every project (moderation).
 * Non-members get 404 rather than 403 so project ids do not leak.
 */
export async function loadProject(c: Ctx, id: string, need: MemberRole): Promise<ProjectRow> {
  const u = requireUser(c);
  const p = await one<ProjectRow>(c.env.DB, `${PROJECT_SELECT} WHERE p.id = ? AND p.status = 'active'`, u.id, id);
  if (!p) throw notFound("project");
  if (!p.role && u.role === "admin") p.role = "owner";
  if (!p.role) throw notFound("project");
  if (RANK[p.role] < RANK[need]) throw forbidden(`requires ${need} role`);
  return p;
}

/**
 * Statements that soft-delete a project: blobs are marked deleted (GC removes the objects
 * and finally the project row), usage is released immediately.
 */
export function deleteProjectStmts(db: DB, p: Pick<ProjectRow, "id" | "owner_id" | "used_bytes">): Stmt[] {
  const t = now();
  return [
    stmt(db, "UPDATE blobs SET status = 'deleted', updated_at = ? WHERE project_id = ? AND status != 'deleted'", t, p.id),
    stmt(db, "UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?", p.used_bytes, p.owner_id),
    stmt(db, "DELETE FROM shares WHERE project_id = ?", p.id),
    stmt(db, "DELETE FROM project_members WHERE project_id = ?", p.id),
    stmt(db, "UPDATE projects SET status = 'deleting', updated_at = ? WHERE id = ?", t, p.id),
  ];
}

/** Soft-deletes active blobs of one project and releases their usage. */
export async function deleteBlobs(db: DB, p: Pick<ProjectRow, "id" | "owner_id">, blobs: { id: string; size: number }[]) {
  if (blobs.length === 0) return 0;
  const t = now();
  const total = blobs.reduce((n, b) => n + b.size, 0);
  const stmts: Stmt[] = [];
  for (const ids of chunks(blobs.map((b) => b.id))) {
    stmts.push(
      stmt(db, `UPDATE blobs SET status = 'deleted', updated_at = ? WHERE status = 'active' AND id IN (${placeholders(ids.length)})`, t, ...ids),
      stmt(db, `DELETE FROM shares WHERE blob_id IN (${placeholders(ids.length)})`, ...ids),
    );
  }
  stmts.push(
    stmt(
      db,
      "UPDATE projects SET used_bytes = MAX(0, used_bytes - ?), blob_count = MAX(0, blob_count - ?), updated_at = ? WHERE id = ?",
      total,
      blobs.length,
      t,
      p.id,
    ),
    stmt(db, "UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?", total, p.owner_id),
  );
  await db.batch(stmts);
  return blobs.length;
}

export type BlobRow = {
  id: string;
  project_id: string;
  storage_id: string;
  object_key: string;
  name: string;
  size: number;
  content_type: string;
  status: "pending" | "active" | "deleted";
  upload_id: string | null;
  part_size: number | null;
  overwrite: number;
  uploader_id: string | null;
  download_count: number;
  created_at: number;
  updated_at: number;
  uploader_username?: string | null;
  uploader_display_name?: string | null;
};

export const BLOB_SELECT = `
  SELECT b.*, u.username AS uploader_username, u.display_name AS uploader_display_name
  FROM blobs b LEFT JOIN users u ON u.id = b.uploader_id`;

export function toBlob(b: BlobRow) {
  return {
    id: b.id,
    project_id: b.project_id,
    name: b.name,
    size: b.size,
    content_type: b.content_type,
    uploader: userRef(b.uploader_id, b.uploader_username ?? null, b.uploader_display_name ?? null),
    download_count: b.download_count,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

/** Loads a blob (default: active) and checks project access. */
export async function loadBlob(c: Ctx, id: string, need: MemberRole, status: BlobRow["status"] = "active") {
  const b = await one<BlobRow>(c.env.DB, `${BLOB_SELECT} WHERE b.id = ? AND b.status = ?`, id, status);
  if (!b) throw notFound(status === "pending" ? "upload" : "file");
  const project = await loadProject(c, b.project_id, need);
  return { blob: b, project };
}
