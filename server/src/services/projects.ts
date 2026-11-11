import { requireUser } from "../auth";
import { all, chunks, now, one, placeholders, stmt, type DB, type Stmt } from "../db";
import type { Ctx } from "../env";
import { b64decode, b64encode } from "../lib/crypto";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { likeArg, publicOrigin } from "../lib/http";
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
  /** Set while the inbox (anonymous uploads at /i/<token>) is enabled. */
  inbox_token: string | null;
  created_at: number;
  updated_at: number;
  owner_username: string | null;
  owner_display_name: string | null;
  storage_name: string | null;
  storage_location: string | null;
  role: MemberRole;
};

/** SELECT list producing a ProjectRow; bind the caller's user id first. */
export const PROJECT_SELECT = `
  SELECT p.*, m.role AS role, o.username AS owner_username, o.display_name AS owner_display_name,
         st.name AS storage_name, st.location AS storage_location
  FROM projects p
  LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
  LEFT JOIN users o ON o.id = p.owner_id
  LEFT JOIN storages st ON st.id = p.storage_id`;

/** The inbox link is shown to members who may upload anyway (editors and owners). */
export function toProject(c: Ctx, p: ProjectRow) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    owner: userRef(p.owner_id, p.owner_username, p.owner_display_name),
    role: p.role,
    storage_id: p.storage_id,
    storage_name: p.storage_name ?? "",
    storage_location: p.storage_location ?? "",
    used_bytes: p.used_bytes,
    blob_count: p.blob_count,
    inbox_enabled: !!p.inbox_token,
    inbox_url: p.inbox_token && RANK[p.role] >= RANK.editor ? `${publicOrigin(c)}/i/${p.inbox_token}` : null,
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
 * Statements that soft-delete a project, constant work however many files it has: the project
 * is flagged (which hides it, its files and its shares at once) and its usage is released. GC
 * then releases files, shares and members in small batches and finally removes the row.
 */
export function deleteProjectStmts(db: DB, p: Pick<ProjectRow, "id" | "owner_id" | "used_bytes">): Stmt[] {
  return [
    stmt(db, "UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?", p.used_bytes, p.owner_id),
    stmt(db, "UPDATE projects SET status = 'deleting', updated_at = ? WHERE id = ? AND status = 'active'", now(), p.id),
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
  /** Uploaded anonymously through the project's inbox. */
  via_inbox: number;
  download_count: number;
  created_at: number;
  updated_at: number;
  uploader_username?: string | null;
  uploader_display_name?: string | null;
};

const blobSelect = (indexedBy?: string) => `
  SELECT b.*, u.username AS uploader_username, u.display_name AS uploader_display_name
  FROM blobs b${indexedBy ? ` INDEXED BY ${indexedBy}` : ""} LEFT JOIN users u ON u.id = b.uploader_id`;

export const BLOB_SELECT = blobSelect();

export function toBlob(b: BlobRow) {
  return {
    id: b.id,
    project_id: b.project_id,
    name: b.name,
    size: b.size,
    content_type: b.content_type,
    uploader: userRef(b.uploader_id, b.uploader_username ?? null, b.uploader_display_name ?? null),
    via_inbox: !!b.via_inbox,
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

// ---- Listing blobs
//
// Each sort has a partial index (project_id, key, id) WHERE status = 'active' (migration 0002),
// so a page reads only its own rows. `cursor` continues after the last row of the previous page
// (keyset paging, cheap at any depth); `offset` is kept for the web UI's numbered pages.

export const BLOB_SORTS = ["name", "size", "created_at"] as const;
export type BlobSort = (typeof BLOB_SORTS)[number];

/** ORDER BY column, and the keyset comparison `(col, id) > (param, ?)` that matches its index. */
const SORT_SQL: Record<BlobSort, { order: string; col: string; param: string }> = {
  name: { order: "b.name COLLATE NOCASE", col: "b.name", param: "? COLLATE NOCASE" },
  size: { order: "b.size", col: "b.size", param: "?" },
  created_at: { order: "b.created_at", col: "b.created_at", param: "?" },
};

export type BlobQuery = {
  sort: BlobSort;
  order: "asc" | "desc";
  limit: number;
  /** Name contains (case-insensitive). Scans the project's files. */
  q?: string;
  /** Name starts with (case-insensitive); an index range. */
  prefix?: string;
  /** Exact names (≤ 50). */
  names?: string[];
  cursor?: string;
  offset?: number;
};

const b64url = (s: string) => b64encode(new TextEncoder().encode(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => new TextDecoder().decode(b64decode(s.replace(/-/g, "+").replace(/_/g, "/")));

function encodeCursor(sort: BlobSort, b: BlobRow): string {
  return b64url(JSON.stringify([sort, sort === "name" ? b.name : sort === "size" ? b.size : b.created_at, b.id]));
}

function decodeCursor(cursor: string, sort: BlobSort): [string | number, string] {
  let v: unknown;
  try {
    v = JSON.parse(unb64url(cursor));
  } catch {
    throw badRequest("invalid cursor");
  }
  if (!Array.isArray(v) || v.length !== 3 || v[0] !== sort || typeof v[2] !== "string")
    throw badRequest("invalid cursor (it must come from the same sort)");
  if (typeof v[1] !== (sort === "name" ? "string" : "number")) throw badRequest("invalid cursor");
  return [v[1], v[2]];
}

/**
 * One page of a project's active blobs. `next_cursor` is set when more rows follow.
 * `total` (matching rows) is computed only for the first request of a listing (no cursor);
 * without filters it is the project's maintained blob_count, so no COUNT(*) is needed.
 */
export async function listBlobs(db: DB, project: Pick<ProjectRow, "id" | "blob_count">, o: BlobQuery) {
  const where = ["b.project_id = ?", "b.status = 'active'"];
  const args: unknown[] = [project.id];
  if (o.q) {
    where.push("b.name LIKE ? ESCAPE '\\'");
    args.push(likeArg(o.q));
  }
  if (o.prefix) {
    where.push("b.name >= ? COLLATE NOCASE AND b.name < ? COLLATE NOCASE");
    args.push(o.prefix, `${o.prefix}\u{10FFFF}`);
  }
  if (o.names?.length) {
    where.push(`b.name IN (${placeholders(o.names.length)})`);
    args.push(...o.names);
  }
  const filtered = where.length > 2;
  // With bound parameters SQLite cannot tell that a name lookup is selective, and prefers scanning
  // the sort's index of the whole project to skip a sort. Pin the name indexes: sorting the few
  // matching rows is cheap.
  const indexedBy = o.names?.length ? "blobs_project_name" : o.prefix ? "blobs_list_name" : undefined;
  const from = `blobs b${indexedBy ? ` INDEXED BY ${indexedBy}` : ""}`;
  const countSql = `SELECT COUNT(*) AS n FROM ${from} WHERE ${where.join(" AND ")}`;
  const countArgs = [...args];

  const s = SORT_SQL[o.sort];
  const dir = o.order === "asc" ? "ASC" : "DESC";
  if (o.cursor) {
    const [value, id] = decodeCursor(o.cursor, o.sort);
    where.push(`(${s.col}, b.id) ${dir === "ASC" ? ">" : "<"} (${s.param}, ?)`);
    args.push(value, id);
  }
  const [rows, count] = await Promise.all([
    all<BlobRow>(
      db,
      `${blobSelect(indexedBy)} WHERE ${where.join(" AND ")} ORDER BY ${s.order} ${dir}, b.id ${dir} LIMIT ? OFFSET ?`,
      ...args,
      o.limit + 1,
      o.cursor ? 0 : (o.offset ?? 0),
    ),
    o.cursor ? null : filtered ? one<{ n: number }>(db, countSql, ...countArgs) : { n: project.blob_count },
  ]);
  const more = rows.length > o.limit;
  if (more) rows.pop();
  return {
    rows,
    total: count ? count.n : undefined,
    next_cursor: more ? encodeCursor(o.sort, rows[rows.length - 1]) : null,
  };
}
