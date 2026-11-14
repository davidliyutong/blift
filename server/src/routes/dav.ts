// WebDAV (RFC 4918) for projects that have it turned on: /dav/<owner>/<project>/…,
// reached through the /dav alias (see app.ts). Clients sign in with HTTP Basic: the username and
// a WebDAV password (services/dav.ts), never the account password.
//
// This is the one place where file bytes pass through the server: WebDAV clients PUT to and GET
// from the URL they were given and cannot be sent to presigned URLs. The body is streamed, so it
// costs no CPU time, but on Workers a request body is limited to 100 MB (larger files go through
// the web UI or the CLI). Each request makes at most two S3 calls.
//
// What the clients it is built for need (Zotero, OmniFocus):
// - Zotero: OPTIONS with a DAV header, PROPFIND depth 0/1, GET (404 for a missing file), PUT,
//   DELETE, and MKCOL answering exactly 201.
// - OmniFocus: MOVE and COPY with Overwrite (412 when the destination exists and Overwrite is F,
//   failure when its parent is missing), a Date header, and a collection whose getlastmodified
//   changes when something in it does. A file's ETag is its blob id: every upload is a new blob.
// - Finder, Windows and Office only write to a server that offers locks (class 2). LOCK and
//   UNLOCK are answered but nothing is locked (see `lock`): the last writer wins, as with every
//   other way of uploading here.
import { Hono } from "hono";
import { all, now, one, stmt, type DB } from "../db";
import type { AppEnv, Ctx, UserRow } from "../env";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { davCredential, type DavPassword } from "../services/dav";
import { davHref, deleteBlobs, listBlobs, PROJECT_SELECT, type BlobRow, type ProjectRow } from "../services/projects";
import { getSettings } from "../services/settings";
import { addStats } from "../services/stats";
import { objectKey, storageFor } from "../services/storage";
import { drainDeletedDirs, isUniqueError, makeDirs, moveBlobs, walkPath } from "../services/tree";
import { hasQuotaFor } from "../services/users";
import { abortUpload, finishUpload, startUpload } from "./uploads";

const METHODS = "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK";
/** What a lock claims to last; clients refresh before it runs out. */
const LOCK_SECONDS = 3600;
/** A request body up to this size is read into memory, so its length is known; larger ones are streamed. */
const BUFFER_MAX = 16 * 1024 ** 2;
/** Files a COPY of a directory may hold (each is an S3 request). */
const COPY_MAX = 25;
/** Rows a request that deletes a directory releases itself (GC does the rest). */
const DRAIN_ROWS = 300;
const PAGE = 1000;

const reply = (status: number, body: BodyInit | null = null, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { date: new Date().toUTCString(), ...headers } });
const fail = (status: number, message = "") => reply(status, message ? `${message}\n` : null, message ? { "content-type": "text/plain; charset=utf-8" } : {});
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const etagOf = (b: Pick<BlobRow, "id">) => `"${b.id}"`;
const httpDate = (ms: number) => new Date(ms).toUTCString();

/** What a URL names: nothing yet (root, an owner), or a project and the path in it. */
type Place = { user: UserRow; cred: DavPassword; segs: string[] };
type InProject = { project: ProjectRow; base: string[]; path: string[] };

/** "/api/dav/alice/demo/a%20b/" → ["alice", "demo", "a b"]; null for names that cannot exist. */
function segments(pathname: string): string[] | null {
  const rest = pathname.replace(/^\/api\/dav|^\/dav/, "");
  try {
    const segs = rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s).normalize("NFC"));
    return segs.some((s) => s === "." || s === ".." || /[/\\\u0000-\u001f\u007f]/.test(s) || s.length > 255) ? null : segs;
  } catch {
    return null;
  }
}

/** The projects this sign-in reaches over WebDAV: enabled, the user is a member, and the password covers them. */
function reachable(db: DB, at: Place, owner?: string) {
  return all<ProjectRow>(
    db,
    `${PROJECT_SELECT} WHERE p.status = 'active' AND p.webdav_enabled = 1 AND (m.role IS NOT NULL OR ? = 'admin')
       AND (? IS NULL OR p.id = ?) AND (? IS NULL OR o.username = ? COLLATE NOCASE) ORDER BY o.username, p.name LIMIT 1000`,
    at.user.id,
    at.user.role,
    at.cred.project_id,
    at.cred.project_id,
    owner ?? null,
    owner ?? null,
  );
}

async function inProject(db: DB, at: Place): Promise<InProject | null> {
  const [owner, name, ...path] = at.segs;
  const project = (await reachable(db, at, owner)).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!project) return null;
  project.role ??= "owner"; // an admin who is not a member
  return { project, base: [project.owner_username ?? owner, project.name], path };
}

const canWrite = (at: Place, p: ProjectRow) => p.role !== "viewer" && !at.cred.readonly;

/** The blob at a path of the project: undefined when missing, null for the project's root. */
async function resolve(db: DB, p: ProjectRow, path: string[]): Promise<BlobRow | null | undefined> {
  if (path.length === 0) return null;
  const rows = await walkPath(db, p.id, path);
  return rows.length === path.length ? rows[rows.length - 1] : undefined;
}

/** The directory a new entry at `path` would go into: its parent_id value, or undefined if it does not exist. */
async function parentOf(db: DB, p: ProjectRow, path: string[]): Promise<string | undefined> {
  const dir = await resolve(db, p, path.slice(0, -1));
  return dir === null ? "" : dir?.kind === "dir" ? dir.id : undefined;
}

/** A change inside a directory shows in its getlastmodified (clients compare it to notice changes). */
const touch = (db: DB, p: ProjectRow, ...dirs: string[]) =>
  db.batch(
    [...new Set(dirs)].map((d) =>
      d ? stmt(db, "UPDATE blobs SET updated_at = ? WHERE id = ?", now(), d) : stmt(db, "UPDATE projects SET updated_at = ? WHERE id = ?", now(), p.id),
    ),
  );

async function remove(db: DB, p: ProjectRow, b: BlobRow) {
  await deleteBlobs(db, p, [b]);
  if (b.kind === "dir") await drainDeletedDirs(db, DRAIN_ROWS, [b.id]);
}

// ---- Preconditions

const tags = (h: string | undefined): string[] => (h ?? "").match(/\*|(?:W\/)?"[^"]*"/g) ?? [];

/** If-Match / If-None-Match against the resource (etag undefined = it does not exist). */
function precondition(c: Ctx, etag: string | undefined): boolean {
  const match = tags(c.req.header("if-match"));
  if (match.length && !(etag !== undefined && (match.includes("*") || match.includes(etag)))) return false;
  const none = tags(c.req.header("if-none-match"));
  if (none.length && etag !== undefined && (none.includes("*") || none.includes(etag))) return false;
  return true;
}

/**
 * The entity tags of an `If` header (`If: <url> (["etag"])`), which OmniFocus sends with MOVE.
 * State tokens are lock tokens; there are no locks here, so they are not checked.
 */
const ifTags = (c: Ctx) => (c.req.header("if") ?? "").match(/\[\s*(?:W\/)?"[^"]*"\s*\]/g)?.map((t) => t.slice(1, -1).trim()) ?? [];

// ---- PROPFIND

type Entry = { href: string; name: string; dir: boolean; size?: number; type?: string; etag?: string; modified: number; created: number };

const entryXml = (e: Entry) =>
  `<D:response><D:href>${esc(e.href)}</D:href><D:propstat><D:prop>` +
  `<D:displayname>${esc(e.name)}</D:displayname>` +
  `<D:resourcetype>${e.dir ? "<D:collection/>" : ""}</D:resourcetype>` +
  (e.dir ? "" : `<D:getcontentlength>${e.size ?? 0}</D:getcontentlength><D:getcontenttype>${esc(e.type ?? "application/octet-stream")}</D:getcontenttype>`) +
  (e.etag ? `<D:getetag>${esc(e.etag)}</D:getetag>` : "") +
  `<D:getlastmodified>${httpDate(e.modified)}</D:getlastmodified><D:creationdate>${new Date(e.created).toISOString()}</D:creationdate>` +
  "<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock><D:lockdiscovery/>" +
  `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;

const blobEntry = (base: string[], dirPath: string[], b: BlobRow): Entry => ({
  href: davHref([...base, ...dirPath, b.name], b.kind === "dir"),
  name: b.name,
  dir: b.kind === "dir",
  size: b.size,
  type: b.content_type,
  etag: b.kind === "dir" ? undefined : etagOf(b),
  modified: b.updated_at,
  created: b.created_at,
});

const collection = (segs: string[], modified: number, created = modified): Entry => ({
  href: davHref(segs),
  name: segs[segs.length - 1] ?? "",
  dir: true,
  modified,
  created,
});

/** 207 Multi-Status; `rest` yields further entries in pages (a directory can hold any number). */
function multistatus(first: Entry[], rest?: () => Promise<Entry[] | null>) {
  const enc = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (!sent) {
        sent = true;
        ctrl.enqueue(enc.encode(`<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${first.map(entryXml).join("")}`));
        return;
      }
      const page = rest ? await rest() : null;
      if (page) ctrl.enqueue(enc.encode(page.map(entryXml).join("")));
      else {
        ctrl.enqueue(enc.encode("</D:multistatus>"));
        ctrl.close();
      }
    },
  });
  return reply(207, body, { "content-type": 'application/xml; charset="utf-8"' });
}

async function propfind(c: Ctx, at: Place) {
  const db = c.env.DB;
  const depth = c.req.header("depth") ?? "infinity";
  if (depth !== "0" && depth !== "1")
    return reply(403, '<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>', { "content-type": 'application/xml; charset="utf-8"' });
  const deep = depth === "1";
  const t = now();
  if (at.segs.length < 2) {
    // The root lists owners, an owner their projects.
    const projects = await reachable(db, at, at.segs[0]);
    if (at.segs.length === 1 && projects.length === 0) return fail(404);
    const kids = at.segs.length
      ? projects.map((p) => collection([p.owner_username ?? at.segs[0], p.name], p.updated_at, p.created_at))
      : [...new Set(projects.map((p) => p.owner_username ?? ""))].map((o) => collection([o], t));
    return multistatus([collection(at.segs.length ? [projects[0].owner_username ?? at.segs[0]] : [], t), ...(deep ? kids : [])]);
  }
  const here = await inProject(db, at);
  if (!here) return fail(404);
  const { project, base, path } = here;
  const target = await resolve(db, project, path);
  if (target === undefined) return fail(404);
  if (target && target.kind !== "dir") return multistatus([blobEntry(base, path.slice(0, -1), target)]);
  const self = target ? blobEntry(base, path.slice(0, -1), target) : collection(base, project.updated_at, project.created_at);
  if (!deep) return multistatus([self]);
  let cursor: string | undefined;
  let done = false;
  return multistatus([self], async () => {
    if (done) return null;
    const page = await listBlobs(db, project, { dir: target?.id ?? "", sort: "name", order: "asc", limit: PAGE, cursor });
    cursor = page.next_cursor ?? undefined;
    done = !cursor;
    return page.rows.map((b) => blobEntry(base, path, b));
  });
}

// ---- GET, PUT

async function get(c: Ctx, at: Place, head: boolean) {
  const here = at.segs.length >= 2 ? await inProject(c.env.DB, at) : null;
  if (at.segs.length >= 2 && !here) return fail(404);
  const b = here ? await resolve(c.env.DB, here.project, here.path) : null;
  if (b === undefined) return fail(404);
  if (!b || b.kind === "dir") return reply(200, head ? null : "This is a WebDAV collection; open it with a WebDAV client.\n", { "content-type": "text/plain; charset=utf-8" });
  const etag = etagOf(b);
  const headers: Record<string, string> = {
    etag,
    "last-modified": httpDate(b.updated_at),
    "content-type": b.content_type,
    "accept-ranges": "bytes",
  };
  if (!tags(c.req.header("if-match")).every((t) => t === "*" || t === etag)) return reply(412);
  if (tags(c.req.header("if-none-match")).some((t) => t === "*" || t === etag)) return reply(304, null, headers);
  if (head) return reply(200, null, { ...headers, "content-length": String(b.size) });
  const { s3 } = await storageFor(c.env, b.storage_id);
  const range = c.req.header("range");
  const res = await s3.get(b.object_key, range ? { range } : {});
  if (!res) return fail(404);
  for (const h of ["content-length", "content-range"]) if (res.headers.has(h)) headers[h] = res.headers.get(h)!;
  addStats(c, { downloads: 1, download_bytes: Number(res.headers.get("content-length") ?? b.size) });
  return reply(res.status, res.body, headers);
}

/** The request body with its length: read into memory when it is small or its length is not given. */
async function bodyOf(req: Request): Promise<{ body: BodyInit; size: number } | Response> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > BUFFER_MAX) {
    const size = Number(declared);
    // Workers send a stream of unknown length chunked, which S3 refuses; FixedLengthStream states it.
    const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
    return { body: Fixed && req.body ? req.body.pipeThrough(new Fixed(size)) : (req.body ?? new Uint8Array()), size };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  for (;;) {
    const r = await reader?.read();
    if (!r || r.done) break;
    size += r.value.byteLength;
    if (size > BUFFER_MAX) return fail(411, "Content-Length is required for files of this size");
    chunks.push(r.value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const ch of chunks) {
    buf.set(ch, off);
    off += ch.byteLength;
  }
  return { body: buf, size };
}

/** PUT; `empty` creates an empty file whatever the request body is (LOCK on a name that is free). */
async function put(c: Ctx, at: Place, empty = false) {
  const db = c.env.DB;
  const here = at.segs.length > 2 ? await inProject(db, at) : null;
  if (!here) return fail(at.segs.length > 2 ? 404 : 403);
  const { project, path } = here;
  if (!canWrite(at, project)) return fail(403);
  const parentId = await parentOf(db, project, path);
  if (parentId === undefined) return fail(409, "the parent collection does not exist");
  const name = path[path.length - 1];
  const existing = await one<BlobRow>(db, "SELECT * FROM blobs WHERE project_id = ? AND parent_id = ? AND name = ? AND status = 'active'", project.id, parentId, name);
  if (existing?.kind === "dir") return fail(405, "a collection has this name");
  if (!empty && !precondition(c, existing ? etagOf(existing) : undefined)) return reply(412);
  const read = empty ? { body: new Uint8Array(), size: 0 } : await bodyOf(c.req.raw);
  if (read instanceof Response) return read;
  const contentType = (!empty && c.req.header("content-type")?.slice(0, 255)) || "application/octet-stream";
  const init = await startUpload(c, project, { name, parentId, size: read.size, contentType, overwrite: true, uploaderId: at.user.id, viaInbox: false, single: true });
  const pending = (await one<BlobRow>(db, "SELECT * FROM blobs WHERE id = ?", init.blob_id))!;
  try {
    const res = await fetch(init.url!, {
      method: "PUT",
      body: read.body,
      headers: { "content-type": contentType, "content-length": String(read.size) },
      ...(read.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
    if (!res.ok) throw new ApiError(502, "storage_error", `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await finishUpload(c, pending, project);
  } catch (e) {
    await abortUpload(c, pending);
    throw e;
  }
  await touch(db, project, parentId);
  return reply(existing ? 204 : 201, null, { etag: etagOf(pending) });
}

// ---- LOCK, UNLOCK

/**
 * Locks in name only. Finder, Windows and Office refuse to write unless the server takes their
 * LOCK, so it is granted: a token comes back and UNLOCK is accepted, but nothing is recorded and
 * no request is ever refused for a lock. Real locks would cost a database read on every write
 * (the resource and each directory above it) and a write per lock, refresh and unlock; nothing
 * else here keeps two people from replacing the same file either. As RFC 4918 asks, locking a
 * name that is free creates an empty file.
 */
async function lock(c: Ctx, at: Place) {
  const db = c.env.DB;
  const here = at.segs.length >= 2 ? await inProject(db, at) : null;
  if (!here) return fail(at.segs.length >= 2 ? 404 : 403);
  if (!canWrite(at, here.project)) return fail(403);
  const text = await c.req.text();
  let status = 200;
  if ((await resolve(db, here.project, here.path)) === undefined) {
    const made = await put(c, at, true);
    if (made.status !== 201) return made;
    status = 201;
  }
  // A refresh names its token in If; a new lock gets a fresh one.
  const token = c.req.header("if")?.match(/<(opaquelocktoken:[^>]+)>/)?.[1] ?? `opaquelocktoken:${crypto.randomUUID()}`;
  const owner = text.match(/<(?:\w+:)?owner[^>]*>([\s\S]*?)<\/(?:\w+:)?owner>/)?.[1].replace(/<[^>]+>/g, "").trim();
  const scope = /<(?:\w+:)?shared\s*\/>/.test(text) ? "shared" : "exclusive";
  const root = davHref([...here.base, ...here.path], false);
  const body =
    `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
    `<D:locktype><D:write/></D:locktype><D:lockscope><D:${scope}/></D:lockscope>` +
    `<D:depth>${c.req.header("depth") === "0" ? "0" : "infinity"}</D:depth>` +
    (owner ? `<D:owner>${esc(owner)}</D:owner>` : "") +
    `<D:timeout>Second-${LOCK_SECONDS}</D:timeout><D:locktoken><D:href>${esc(token)}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${esc(root)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`;
  return reply(status, body, { "content-type": 'application/xml; charset="utf-8"', "lock-token": `<${token}>` });
}

// ---- DELETE, MKCOL, MOVE, COPY

async function del(c: Ctx, at: Place) {
  const db = c.env.DB;
  const here = at.segs.length > 2 ? await inProject(db, at) : null;
  if (!here) return fail(at.segs.length > 2 ? 404 : 403);
  if (!canWrite(at, here.project)) return fail(403);
  const b = await resolve(db, here.project, here.path);
  if (!b) return fail(404);
  if (!precondition(c, b.kind === "dir" ? undefined : etagOf(b)) && b.kind !== "dir") return reply(412);
  await remove(db, here.project, b);
  await touch(db, here.project, b.parent_id);
  return reply(204);
}

async function mkcol(c: Ctx, at: Place) {
  const db = c.env.DB;
  const here = at.segs.length > 2 ? await inProject(db, at) : null;
  if (!here) return fail(at.segs.length > 2 ? 404 : at.segs.length === 2 ? 405 : 403);
  if (!canWrite(at, here.project)) return fail(403);
  if ((await c.req.arrayBuffer()).byteLength) return fail(415);
  const parentId = await parentOf(db, here.project, here.path);
  if (parentId === undefined) return fail(409, "the parent collection does not exist");
  try {
    await makeDirs(db, here.project.id, parentId, here.path.slice(-1), { parents: false, userId: at.user.id });
  } catch (e) {
    if (e instanceof ApiError && e.code === "name_taken") return fail(405, "the resource already exists");
    throw e;
  }
  await touch(db, here.project, parentId);
  return reply(201);
}

/** Copies a file (one S3 CopyObject) or a directory with what is in it, up to `budget.left` files. */
async function copyInto(c: Ctx, p: ProjectRow, src: BlobRow, parentId: string, name: string, userId: string, budget: { left: number }) {
  const db = c.env.DB;
  if (src.kind === "dir") {
    const { dir } = await makeDirs(db, p.id, parentId, [name], { parents: false, userId });
    for (const kid of await all<BlobRow>(
      db,
      `SELECT * FROM blobs INDEXED BY blobs_project_name WHERE project_id = ? AND parent_id = ? AND status = 'active' LIMIT ${COPY_MAX + 1}`,
      p.id,
      src.id,
    ))
      await copyInto(c, p, kid, dir.id, kid.name, userId, budget);
    return;
  }
  if (budget.left-- <= 0) throw new ApiError(507, "bad_request", `a copy takes at most ${COPY_MAX} files`);
  const owner = await one<UserRow>(db, "SELECT * FROM users WHERE id = ?", p.owner_id);
  if (!owner || !hasQuotaFor(owner, await getSettings(db), src.size)) throw new ApiError(507, "quota_exceeded", "storage quota of the project owner exceeded");
  const { s3, row: storage } = await storageFor(c.env, p.storage_id);
  const id = newId();
  const key = objectKey(storage, p.id, id);
  await s3.copy(src.object_key, key);
  const t = now();
  await db.batch([
    stmt(
      db,
      `INSERT INTO blobs (id, project_id, parent_id, storage_id, object_key, name, size, content_type, status, uploader_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      id,
      p.id,
      parentId,
      storage.id,
      key,
      name,
      src.size,
      src.content_type,
      userId,
      t,
      t,
    ),
    stmt(db, "UPDATE projects SET used_bytes = used_bytes + ?, blob_count = blob_count + 1, updated_at = ? WHERE id = ?", src.size, t, p.id),
    stmt(db, "UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?", src.size, p.owner_id),
  ]);
}

async function moveOrCopy(c: Ctx, at: Place, move: boolean) {
  const db = c.env.DB;
  const here = at.segs.length > 2 ? await inProject(db, at) : null;
  if (!here) return fail(at.segs.length > 2 ? 404 : 403);
  const { project, path } = here;
  if (!canWrite(at, project)) return fail(403);
  let dest: string[] | null = null;
  try {
    dest = segments(new URL(c.req.header("destination") ?? "", c.req.url).pathname);
  } catch {
    /* not a URL */
  }
  if (!dest || !c.req.header("destination")) return fail(400, "Destination is required");
  // Inside the same project only.
  const [owner, name, ...to] = dest;
  if (dest.length < 3 || owner?.toLowerCase() !== here.base[0].toLowerCase() || name?.toLowerCase() !== here.base[1].toLowerCase())
    return fail(502, "the destination must be in the same project");
  const src = await resolve(db, project, path);
  if (!src) return fail(404);
  const wanted = ifTags(c);
  if (wanted.length && !(src.kind !== "dir" && wanted.includes(etagOf(src)))) {
    // The tagged resource may be the destination (OmniFocus names the collection it replaces).
    const target = await resolve(db, project, to);
    if (!(target && target.kind !== "dir" && wanted.includes(etagOf(target)))) return reply(412);
  }
  const parentId = await parentOf(db, project, to);
  if (parentId === undefined) return fail(409, "the destination's parent collection does not exist");
  const newName = to[to.length - 1];
  const existing = await one<BlobRow>(db, "SELECT * FROM blobs WHERE project_id = ? AND parent_id = ? AND name = ? AND status = 'active'", project.id, parentId, newName);
  if (existing?.id === src.id) return fail(403, "source and destination are the same");
  if (existing && (c.req.header("overwrite") ?? "T").toUpperCase() === "F") return reply(412);
  // A directory cannot go into itself; moveBlobs checks moves, a copy is checked here.
  if (!move && src.kind === "dir" && (await walkPath(db, project.id, to.slice(0, -1))).some((d) => d.id === src.id)) return fail(403);
  if (existing) await remove(db, project, existing);
  try {
    if (move) await moveBlobs(db, project.id, [src], { to: parentId, name: newName });
    else await copyInto(c, project, src, parentId, newName, at.user.id, { left: COPY_MAX });
  } catch (e) {
    if (isUniqueError(e)) return reply(412);
    throw e;
  }
  await touch(db, project, parentId, ...(move ? [src.parent_id] : []));
  return reply(existing ? 204 : 201, null, { location: davHref([...here.base, ...to], src.kind === "dir") });
}

// ---- Entry

/**
 * Reads what is left of a request body the handler refused (a 412, a 403): a connection with
 * unread bytes on it cannot be reused, and clients keep theirs open. Large ones are let go.
 */
async function discard(req: Request) {
  if (req.bodyUsed || !req.body) return;
  if (Number(req.headers.get("content-length") ?? 0) > BUFFER_MAX) return void req.body.cancel().catch(() => undefined);
  const reader = req.body.getReader();
  try {
    while (!(await reader.read()).done);
  } catch {
    /* the client went away */
  }
}

const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, name_taken: 405, quota_exceeded: 507, bad_request: 400, conflict: 409 };

const dav = new Hono<AppEnv>();

dav.all("*", async (c) => {
  const method = c.req.method.toUpperCase();
  // Clients ask what the server can do before they sign in.
  if (method === "OPTIONS") return reply(200, null, { dav: "1, 2", allow: METHODS, "ms-author-via": "DAV", "content-length": "0" });
  const cred = await davCredential(c);
  if (!cred) {
    await discard(c.req.raw);
    return reply(401, "Sign in with your username and a WebDAV password.\n", { "www-authenticate": 'Basic realm="blift", charset="UTF-8"' });
  }
  c.set("user", cred.user);
  const segs = segments(new URL(c.req.url).pathname);
  if (!segs) return fail(400, "invalid path");
  const at: Place = { user: cred.user, cred: cred.password, segs };
  const res = await handle(c, at, method);
  await discard(c.req.raw);
  return res;
});

async function handle(c: Ctx, at: Place, method: string): Promise<Response> {
  try {
    switch (method) {
      case "PROPFIND":
        return await propfind(c, at);
      case "GET":
      case "HEAD":
        return await get(c, at, method === "HEAD");
      case "PUT":
        return await put(c, at);
      case "DELETE":
        return await del(c, at);
      case "MKCOL":
        return await mkcol(c, at);
      case "MOVE":
      case "COPY":
        return await moveOrCopy(c, at, method === "MOVE");
      case "LOCK":
        return await lock(c, at);
      case "UNLOCK":
        return c.req.header("lock-token") ? reply(204) : fail(400, "Lock-Token is required");
      case "PROPPATCH":
        // Dead properties are not kept; the request is accepted so clients that set dates carry on.
        return multistatus([]);
      default:
        return reply(405, null, { allow: METHODS });
    }
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return fail(STATUS[e.code] ?? e.status, e.message);
  }
}

export default dav;
