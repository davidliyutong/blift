import { requireUser } from "../auth";
import { all, chunks, now, one, placeholders, stmt, type DB, type Stmt } from "../db";
import type { Ctx } from "../env";
import { b64decode, b64encode } from "../lib/crypto";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { likeArg } from "../lib/http";
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

/**
 * Soft-deletes active blobs of one project and releases their usage. A directory is only
 * flagged, which makes everything below it unreachable by path at once; its contents are
 * released by `drainDeletedDirs` (services/tree.ts), in the request for small directories and by
 * GC for the rest.
 */
export async function deleteBlobs(db: DB, p: Pick<ProjectRow, "id" | "owner_id">, blobs: { id: string; size: number; kind?: BlobKind }[]) {
  if (blobs.length === 0) return 0;
  const t = now();
  const files = blobs.filter((b) => b.kind !== "dir");
  const total = files.reduce((n, b) => n + b.size, 0);
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
      files.length,
      t,
      p.id,
    ),
    stmt(db, "UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?", total, p.owner_id),
  );
  await db.batch(stmts);
  return blobs.length;
}

export type BlobKind = "file" | "dir";

/** A file, or a directory (kind 'dir': no object in storage, size 0). */
export type BlobRow = {
  id: string;
  project_id: string;
  /** The directory it is in; '' = the project's root. */
  parent_id: string;
  kind: BlobKind;
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
  /** Uploaded anonymously through an upload link (a share with mode 'upload'). */
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

/** `path` is the blob's path in its project ("docs/a.txt"); see `withPaths` in services/tree.ts. */
export function toBlob(b: BlobRow, path: string) {
  return {
    id: b.id,
    project_id: b.project_id,
    parent_id: b.parent_id || null,
    kind: b.kind,
    name: b.name,
    path,
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
// Two listings, both read in index order and paged with keyset cursors (cheap at any depth):
// - one directory (`dir` set): its directories first, then its files, each in the requested
//   sort; indexes (project_id, parent_id, kind, key, id) WHERE status = 'active' (migration 0007).
// - all files of the project, whatever their directory (`dir` unset; search, recursive listings);
//   indexes (project_id, key, id) WHERE status = 'active' (migration 0002). `offset` is kept
//   here for the web UI's numbered pages.

export const BLOB_SORTS = ["name", "size", "created_at"] as const;
export type BlobSort = (typeof BLOB_SORTS)[number];

/** ORDER BY column, the keyset comparison `(col, id) > (param, ?)` and the indexes that match. */
const SORT_SQL: Record<BlobSort, { order: string; col: string; param: string; flat: string; dir: string }> = {
  name: { order: "b.name COLLATE NOCASE", col: "b.name", param: "? COLLATE NOCASE", flat: "blobs_list_name", dir: "blobs_dir_name" },
  size: { order: "b.size", col: "b.size", param: "?", flat: "blobs_list_size", dir: "blobs_dir_size" },
  created_at: { order: "b.created_at", col: "b.created_at", param: "?", flat: "blobs_list_created", dir: "blobs_dir_created" },
};

export type BlobQuery = {
  sort: BlobSort;
  order: "asc" | "desc";
  limit: number;
  /** List this directory ('' = the root) instead of all files of the project. */
  dir?: string;
  /** Name contains (case-insensitive). Scans the listing. */
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

type Cursor = { value: string | number; id: string; kind: BlobKind };

function encodeCursor(sort: BlobSort, b: BlobRow): string {
  return b64url(JSON.stringify([sort, sort === "name" ? b.name : sort === "size" ? b.size : b.created_at, b.id, b.kind]));
}

function decodeCursor(cursor: string, sort: BlobSort): Cursor {
  let v: unknown;
  try {
    v = JSON.parse(unb64url(cursor));
  } catch {
    throw badRequest("invalid cursor");
  }
  if (!Array.isArray(v) || v.length < 3 || v[0] !== sort || typeof v[2] !== "string")
    throw badRequest("invalid cursor (it must come from the same sort)");
  if (typeof v[1] !== (sort === "name" ? "string" : "number")) throw badRequest("invalid cursor");
  return { value: v[1], id: v[2], kind: v[3] === "dir" ? "dir" : "file" };
}

/**
 * One page of a project's active blobs. `next_cursor` is set when more rows follow.
 * `total` (matching rows) is computed only for the first request of a listing of all files (no
 * cursor); without filters it is the project's maintained blob_count, so no COUNT(*) is needed.
 * Directory listings have no total.
 */
export async function listBlobs(db: DB, project: Pick<ProjectRow, "id" | "blob_count">, o: BlobQuery) {
  const s = SORT_SQL[o.sort];
  const dir = o.order === "asc" ? "ASC" : "DESC";
  const inDir = o.dir !== undefined;
  const filters: string[] = [];
  const filterArgs: unknown[] = [];
  if (o.q) {
    filters.push("b.name LIKE ? ESCAPE '\\'");
    filterArgs.push(likeArg(o.q));
  }
  if (o.prefix) {
    filters.push("b.name >= ? COLLATE NOCASE AND b.name < ? COLLATE NOCASE");
    filterArgs.push(o.prefix, `${o.prefix}\u{10FFFF}`);
  }
  if (o.names?.length) {
    // The NOCASE comparison is the one the name indexes can answer; the exact one filters.
    const ph = placeholders(o.names.length);
    filters.push(`b.name COLLATE NOCASE IN (${ph}) AND b.name IN (${ph})`);
    filterArgs.push(...o.names, ...o.names);
  }
  // With bound parameters SQLite cannot tell that a name lookup is selective, and prefers scanning
  // the sort's index to skip a sort. Pin the name index: sorting the few matching rows is cheap.
  const byName = !!(o.names?.length || o.prefix);
  const index = inDir ? (byName ? SORT_SQL.name.dir : s.dir) : byName ? SORT_SQL.name.flat : undefined;

  /** Rows of one kind after `after`, in index order. */
  const page = (kind: BlobKind, limit: number, after?: Cursor, offset = 0) => {
    const where = ["b.project_id = ?", ...(inDir ? ["b.parent_id = ?"] : []), "b.kind = ?", "b.status = 'active'", ...filters];
    const args: unknown[] = [project.id, ...(inDir ? [o.dir] : []), kind, ...filterArgs];
    if (after) {
      where.push(`(${s.col}, b.id) ${dir === "ASC" ? ">" : "<"} (${s.param}, ?)`);
      args.push(after.value, after.id);
    }
    return all<BlobRow>(
      db,
      `${blobSelect(index)} WHERE ${where.join(" AND ")} ORDER BY ${s.order} ${dir}, b.id ${dir} LIMIT ? OFFSET ?`,
      ...args,
      limit,
      offset,
    );
  };

  const after = o.cursor ? decodeCursor(o.cursor, o.sort) : undefined;
  let rows: BlobRow[];
  let total: number | undefined;
  if (inDir) {
    // Directories first; files fill the rest of the page.
    rows = after?.kind === "file" ? [] : await page("dir", o.limit + 1, after);
    if (rows.length <= o.limit) rows.push(...(await page("file", o.limit + 1 - rows.length, after?.kind === "file" ? after : undefined)));
  } else {
    const count = async () => {
      if (after) return undefined;
      if (!filters.length) return project.blob_count;
      const from = `blobs b${index ? ` INDEXED BY ${index}` : ""}`;
      const where = ["b.project_id = ?", "b.kind = 'file'", "b.status = 'active'", ...filters].join(" AND ");
      return (await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`, project.id, ...filterArgs))?.n;
    };
    [rows, total] = await Promise.all([page("file", o.limit + 1, after, after ? 0 : (o.offset ?? 0)), count()]);
  }
  const more = rows.length > o.limit;
  if (more) rows.length = o.limit;
  return { rows, total, next_cursor: more ? encodeCursor(o.sort, rows[rows.length - 1]) : null };
}
