import { Hono } from "hono";
import { requireAdmin } from "../auth";
import { all, now, one, run, stmt } from "../db";
import type { AppEnv, Ctx, UserRow } from "../env";
import { decrypt, encrypt } from "../lib/crypto";
import { badRequest, conflict, notFound } from "../lib/errors";
import { body, int, likeArg, oneOf, optStr, publicOrigin, str } from "../lib/http";
import { newId, randomString } from "../lib/ids";
import { discover } from "../lib/oidc";
import { S3 } from "../lib/s3";
import { runGc } from "../services/gc";
import { deleteProjectStmts, PROJECT_SELECT, toProject, type ProjectRow } from "../services/projects";
import { getSettings, putSetting, type Settings } from "../services/settings";
import { day } from "../services/stats";
import { storageFor, type StorageRow } from "../services/storage";
import { effectiveQuota, toUser } from "../services/users";
import { redirectUri } from "./oidc";

const r = new Hono<AppEnv>();

r.use("*", async (c, next) => {
  requireAdmin(c);
  await next();
});

// ---- Dashboard

r.get("/stats", async (c) => {
  const db = c.env.DB;
  const days = int(c.req.query("days") ?? 30, "days", 1, 366);
  const since = now() - (days - 1) * 86_400_000;
  const s = await getSettings(db);
  const [totals, series, top, storages, traffic] = await Promise.all([
    one<Record<string, number>>(
      db,
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM projects WHERE status = 'active') AS projects,
         (SELECT COUNT(*) FROM blobs WHERE status = 'active') AS blobs,
         (SELECT COALESCE(SUM(used_bytes), 0) FROM projects WHERE status = 'active') AS used_bytes,
         (SELECT COUNT(*) FROM shares) AS shares,
         (SELECT COUNT(*) FROM storages) AS storages`,
    ),
    all<{ day: string; requests: number; upload_bytes: number; download_bytes: number; uploads: number; downloads: number }>(
      db,
      `SELECT day, SUM(requests) AS requests, SUM(upload_bytes) AS upload_bytes, SUM(download_bytes) AS download_bytes,
              SUM(uploads) AS uploads, SUM(downloads) AS downloads
       FROM stats_daily WHERE day >= ? GROUP BY day`,
      day(since),
    ),
    all<UserRow>(db, "SELECT * FROM users ORDER BY used_bytes DESC, username LIMIT 10"),
    all<{ id: string; name: string; used_bytes: number; blob_count: number }>(
      db,
      `SELECT st.id, st.name, COALESCE(SUM(p.used_bytes), 0) AS used_bytes, COALESCE(SUM(p.blob_count), 0) AS blob_count
       FROM storages st LEFT JOIN projects p ON p.storage_id = st.id AND p.status = 'active'
       GROUP BY st.id ORDER BY st.created_at`,
    ),
    all<{ id: string; username: string | null; display_name: string | null; requests: number; upload_bytes: number; download_bytes: number }>(
      db,
      `SELECT sd.user_id AS id, u.username, u.display_name, SUM(sd.requests) AS requests,
              SUM(sd.upload_bytes) AS upload_bytes, SUM(sd.download_bytes) AS download_bytes
       FROM stats_daily sd LEFT JOIN users u ON u.id = sd.user_id
       WHERE sd.day >= ? GROUP BY sd.user_id
       ORDER BY SUM(sd.upload_bytes) + SUM(sd.download_bytes) DESC, SUM(sd.requests) DESC LIMIT 10`,
      day(since),
    ),
  ]);
  // Dense series: one point per day, zeros where there was no traffic.
  const byDay = new Map(series.map((p) => [p.day, p]));
  const dense = Array.from({ length: days }, (_, i) => {
    const d = day(since + i * 86_400_000);
    return byDay.get(d) ?? { day: d, requests: 0, upload_bytes: 0, download_bytes: 0, uploads: 0, downloads: 0 };
  });
  return c.json({
    totals,
    series: dense,
    top_users: top.map((u) => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      used_bytes: u.used_bytes,
      quota_bytes: effectiveQuota(u, s),
    })),
    storages,
    // id "" = anonymous traffic (login pages, public share views)
    top_traffic: traffic,
  });
});

// ---- Users

type AdminUserRow = UserRow & { project_count: number };

const toAdminUser = (u: AdminUserRow, s: Settings) => ({
  ...toUser(u, s),
  status: u.status,
  quota_override: u.quota_bytes,
  last_login_at: u.last_login_at,
  project_count: u.project_count,
});

const ADMIN_USER_SELECT = `
  SELECT u.*, (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.status = 'active') AS project_count
  FROM users u`;

async function otherActiveAdmins(c: Ctx, id: string) {
  return (await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?", id))!.n;
}

r.get("/users", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const limit = int(c.req.query("limit") ?? 50, "limit", 1, 500);
  const offset = int(c.req.query("offset") ?? 0, "offset", 0, 1e9);
  const where = q ? "WHERE u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\'" : "";
  const args = q ? [likeArg(q), likeArg(q), likeArg(q)] : [];
  const [rows, total, s] = await Promise.all([
    all<AdminUserRow>(c.env.DB, `${ADMIN_USER_SELECT} ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset),
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM users u ${where}`, ...args),
    getSettings(c.env.DB),
  ]);
  return c.json({ users: rows.map((u) => toAdminUser(u, s)), total: total?.n ?? 0 });
});

r.patch("/users/:id", async (c) => {
  const id = c.req.param("id");
  const u = await one<UserRow>(c.env.DB, "SELECT * FROM users WHERE id = ?", id);
  if (!u) throw notFound("user");
  const b = await body(c);
  const role = b.role === undefined ? u.role : oneOf(b.role, "role", ["admin", "user"] as const);
  const status = b.status === undefined ? u.status : oneOf(b.status, "status", ["active", "disabled"] as const);
  const quota = b.quota_bytes === undefined ? u.quota_bytes : b.quota_bytes === null ? null : int(b.quota_bytes, "quota_bytes", -1, Number.MAX_SAFE_INTEGER);
  const losesAdmin = u.role === "admin" && u.status === "active" && (role !== "admin" || status !== "active");
  if (losesAdmin && (await otherActiveAdmins(c, id)) === 0) throw conflict("conflict", "cannot remove the last active admin");

  const stmts = [stmt(c.env.DB, "UPDATE users SET role = ?, status = ?, quota_bytes = ? WHERE id = ?", role, status, quota, id)];
  if (status === "disabled") stmts.push(stmt(c.env.DB, "DELETE FROM sessions WHERE user_id = ?", id));
  await c.env.DB.batch(stmts);
  const row = await one<AdminUserRow>(c.env.DB, `${ADMIN_USER_SELECT} WHERE u.id = ?`, id);
  return c.json(toAdminUser(row!, await getSettings(c.env.DB)));
});

r.post("/users/:id/reset-mfa", async (c) => {
  if (!(await run(c.env.DB, "UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?", c.req.param("id")))) throw notFound("user");
  return c.body(null, 204);
});

r.delete("/users/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  if (id === c.get("user")!.id) throw badRequest("you cannot delete yourself");
  const u = await one<UserRow>(db, "SELECT * FROM users WHERE id = ?", id);
  if (!u) throw notFound("user");
  if (u.role === "admin" && (await otherActiveAdmins(c, id)) === 0) throw conflict("conflict", "cannot remove the last active admin");
  const owned = await all<{ id: string; owner_id: string; used_bytes: number }>(
    db,
    "SELECT id, owner_id, used_bytes FROM projects WHERE owner_id = ? AND status = 'active'",
    id,
  );
  await db.batch([
    ...owned.flatMap((p) => deleteProjectStmts(db, p)),
    stmt(db, "DELETE FROM shares WHERE creator_id = ?", id),
    stmt(db, "DELETE FROM project_members WHERE user_id = ?", id),
    stmt(db, "DELETE FROM sessions WHERE user_id = ?", id),
    stmt(db, "DELETE FROM cli_logins WHERE user_id = ?", id),
    stmt(db, "DELETE FROM users WHERE id = ?", id),
  ]);
  return c.body(null, 204);
});

// ---- Projects (all of them)

r.get("/projects", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const limit = int(c.req.query("limit") ?? 50, "limit", 1, 500);
  const offset = int(c.req.query("offset") ?? 0, "offset", 0, 1e9);
  const where = `p.status = 'active'${q ? " AND (p.name LIKE ? ESCAPE '\\' OR o.username LIKE ? ESCAPE '\\')" : ""}`;
  const args = q ? [likeArg(q), likeArg(q)] : [];
  const uid = c.get("user")!.id;
  const [rows, total] = await Promise.all([
    all<ProjectRow>(c.env.DB, `${PROJECT_SELECT} WHERE ${where} ORDER BY p.used_bytes DESC LIMIT ? OFFSET ?`, uid, ...args, limit, offset),
    one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM projects p LEFT JOIN users o ON o.id = p.owner_id WHERE ${where}`, ...args),
  ]);
  return c.json({ projects: rows.map((p) => toProject({ ...p, role: p.role ?? "owner" })), total: total?.n ?? 0 });
});

// ---- Storage backends

const PROVIDERS = ["s3", "r2", "b2", "rustfs", "minio", "other"] as const;

const toAdminStorage = (s: StorageRow & { project_count: number; used_bytes: number }) => ({
  id: s.id,
  name: s.name,
  provider: s.provider,
  endpoint: s.endpoint,
  region: s.region,
  bucket: s.bucket,
  access_key_id: s.access_key_id,
  path_style: !!s.path_style,
  prefix: s.prefix,
  is_default: !!s.is_default,
  created_at: s.created_at,
  project_count: s.project_count,
  used_bytes: s.used_bytes,
});

const STORAGE_SELECT = `
  SELECT st.*,
    (SELECT COUNT(*) FROM projects p WHERE p.storage_id = st.id AND p.status = 'active') AS project_count,
    (SELECT COALESCE(SUM(used_bytes), 0) FROM projects p WHERE p.storage_id = st.id AND p.status = 'active') AS used_bytes
  FROM storages st`;

type StorageInput = Omit<StorageRow, "id" | "created_at" | "updated_at" | "path_style" | "is_default"> & {
  path_style: boolean;
  is_default: boolean;
};

/** Validates a (possibly partial) storage config merged over `base`. */
function storageInput(b: Record<string, unknown>, base?: StorageRow): StorageInput {
  const pick = (k: keyof StorageRow) => (b[k] !== undefined ? b[k] : base?.[k]);
  const endpoint = str(pick("endpoint"), "endpoint", 512).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(endpoint)) throw badRequest("endpoint must be an http(s) URL");
  const prefix = String(pick("prefix") ?? "").trim().replace(/^\/+/, "");
  if (!/^[A-Za-z0-9._/-]*$/.test(prefix)) throw badRequest("prefix may only contain letters, digits, '.', '_', '-', '/'");
  const bucket = str(pick("bucket"), "bucket", 63);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(bucket)) throw badRequest("invalid bucket name");
  return {
    name: str(pick("name"), "name", 64),
    provider: oneOf(pick("provider") ?? "s3", "provider", PROVIDERS),
    endpoint,
    region: optStr(pick("region"), "region", 64) ?? "auto",
    bucket,
    access_key_id: str(pick("access_key_id"), "access_key_id", 256),
    secret_access_key: typeof b.secret_access_key === "string" ? b.secret_access_key : "",
    path_style: b.path_style !== undefined ? !!b.path_style : base ? !!base.path_style : true,
    prefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix,
    is_default: b.is_default !== undefined ? !!b.is_default : !!base?.is_default,
  };
}

r.get("/storages", async (c) => {
  const rows = await all<StorageRow & { project_count: number; used_bytes: number }>(c.env.DB, `${STORAGE_SELECT} ORDER BY st.created_at`);
  return c.json({ storages: rows.map(toAdminStorage) });
});

async function saveStorage(c: Ctx, id: string, s: StorageInput, secretEnc: string, isNew: boolean) {
  const db = c.env.DB;
  const t = now();
  const first = isNew && !(await one(db, "SELECT 1 AS x FROM storages LIMIT 1"));
  const isDefault = s.is_default || first;
  const stmts = isDefault ? [stmt(db, "UPDATE storages SET is_default = 0")] : [];
  stmts.push(
    isNew
      ? stmt(
          db,
          `INSERT INTO storages (id, name, provider, endpoint, region, bucket, access_key_id, secret_access_key, path_style, prefix, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, s.name, s.provider, s.endpoint, s.region, s.bucket, s.access_key_id, secretEnc, s.path_style, s.prefix, isDefault, t, t,
        )
      : stmt(
          db,
          `UPDATE storages SET name = ?, provider = ?, endpoint = ?, region = ?, bucket = ?, access_key_id = ?, secret_access_key = ?,
             path_style = ?, prefix = ?, is_default = ?, updated_at = ? WHERE id = ?`,
          s.name, s.provider, s.endpoint, s.region, s.bucket, s.access_key_id, secretEnc, s.path_style, s.prefix, isDefault, t, id,
        ),
  );
  await db.batch(stmts);
  const row = await one<StorageRow & { project_count: number; used_bytes: number }>(db, `${STORAGE_SELECT} WHERE st.id = ?`, id);
  return toAdminStorage(row!);
}

r.post("/storages", async (c) => {
  const s = storageInput(await body(c));
  if (!s.secret_access_key) throw badRequest("secret_access_key is required");
  return c.json(await saveStorage(c, newId(), s, await encrypt(c.env.APP_SECRET, s.secret_access_key), true), 201);
});

r.patch("/storages/:id", async (c) => {
  const base = await one<StorageRow>(c.env.DB, "SELECT * FROM storages WHERE id = ?", c.req.param("id"));
  if (!base) throw notFound("storage");
  const s = storageInput(await body(c), base);
  const secret = s.secret_access_key ? await encrypt(c.env.APP_SECRET, s.secret_access_key) : base.secret_access_key;
  return c.json(await saveStorage(c, base.id, s, secret, false));
});

r.delete("/storages/:id", async (c) => {
  const id = c.req.param("id");
  if (
    (await one(c.env.DB, "SELECT 1 AS x FROM projects WHERE storage_id = ? LIMIT 1", id)) ||
    (await one(c.env.DB, "SELECT 1 AS x FROM blobs WHERE storage_id = ? LIMIT 1", id))
  )
    throw conflict("conflict", "storage is still used by projects or files pending deletion");
  if (!(await run(c.env.DB, "DELETE FROM storages WHERE id = ?", id))) throw notFound("storage");
  return c.body(null, 204);
});

// Round-trip test: PUT, HEAD and DELETE a small object. Works with unsaved configs.
r.post("/storages/test", async (c) => {
  const b = await body(c);
  const base = b.id ? await one<StorageRow>(c.env.DB, "SELECT * FROM storages WHERE id = ?", b.id) : null;
  const s = storageInput(b, base ?? undefined);
  const secret = s.secret_access_key || (base ? await decrypt(c.env.APP_SECRET, base.secret_access_key) : "");
  if (!secret) throw badRequest("secret_access_key is required");
  const s3 = new S3({
    endpoint: s.endpoint,
    region: s.region,
    bucket: s.bucket,
    accessKeyId: s.access_key_id,
    secretAccessKey: secret,
    pathStyle: s.path_style,
  });
  const key = `${s.prefix}.blift-test-${randomString(8)}`;
  const started = Date.now();
  try {
    await s3.put(key, "blift storage test");
    if (!(await s3.head(key))) throw new Error("object not found after upload");
    await s3.delete(key);
    return c.json({ ok: true, latency_ms: Date.now() - started });
  } catch (e) {
    return c.json({ ok: false, latency_ms: Date.now() - started, error: (e as Error).message });
  }
});

r.post("/storages/:id/cors", async (c) => {
  const { s3 } = await storageFor(c.env, c.req.param("id"));
  const b = await c.req.json().catch(() => ({}) as { origins?: unknown });
  const origins = Array.isArray(b.origins) && b.origins.length ? b.origins.map(String) : [publicOrigin(c)];
  try {
    await s3.putCors(origins);
    return c.json({ ok: true, origins });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message });
  }
});

// ---- Settings

const publicSettings = (c: Ctx, s: Settings) => ({
  site: s.site,
  oidc: {
    enabled: s.oidc.enabled,
    issuer: s.oidc.issuer,
    client_id: s.oidc.client_id,
    client_secret_set: !!s.oidc.client_secret,
    scopes: s.oidc.scopes,
    button_label: s.oidc.button_label,
    admin_group: s.oidc.admin_group,
    redirect_uri: redirectUri(c),
  },
  gc: s.gc,
});

r.get("/settings", async (c) => c.json(publicSettings(c, await getSettings(c.env.DB))));

r.put("/settings", async (c) => {
  const db = c.env.DB;
  const b = await body<Record<string, Record<string, unknown> | undefined>>(c);
  const s = await getSettings(db);
  if (b.site) {
    const site = { ...s.site };
    if (b.site.name !== undefined) site.name = str(b.site.name, "site.name", 64);
    if (b.site.default_quota_bytes !== undefined)
      site.default_quota_bytes = int(b.site.default_quota_bytes, "site.default_quota_bytes", -1, Number.MAX_SAFE_INTEGER);
    await putSetting(db, "site", site);
  }
  if (b.oidc) {
    const o = { ...s.oidc };
    const x = b.oidc;
    if (x.enabled !== undefined) o.enabled = !!x.enabled;
    if (x.issuer !== undefined) o.issuer = String(x.issuer).trim();
    if (x.client_id !== undefined) o.client_id = String(x.client_id).trim();
    if (typeof x.client_secret === "string" && x.client_secret) o.client_secret = await encrypt(c.env.APP_SECRET, x.client_secret);
    if (x.client_secret === null) o.client_secret = "";
    if (x.scopes !== undefined) o.scopes = String(x.scopes).trim() || "openid profile email";
    if (x.button_label !== undefined) o.button_label = String(x.button_label).trim().slice(0, 64) || "SSO";
    if (x.admin_group !== undefined) o.admin_group = String(x.admin_group).trim();
    if (o.issuer && !/^https?:\/\//.test(o.issuer)) throw badRequest("issuer must be an http(s) URL");
    if (!o.scopes.split(/\s+/).includes("openid")) throw badRequest("scopes must include openid");
    if (o.enabled && (!o.issuer || !o.client_id)) throw badRequest("issuer and client_id are required to enable OIDC");
    await putSetting(db, "oidc", o);
  }
  if (b.gc) {
    const gc = { ...s.gc };
    if (b.gc.pending_upload_ttl_hours !== undefined)
      gc.pending_upload_ttl_hours = int(b.gc.pending_upload_ttl_hours, "gc.pending_upload_ttl_hours", 1, 720);
    await putSetting(db, "gc", gc);
  }
  return c.json(publicSettings(c, await getSettings(db)));
});

r.post("/oidc/test", async (c) => {
  const issuer = str((await body(c)).issuer, "issuer", 512);
  try {
    const d = await discover(issuer, true);
    return c.json({ ok: true, discovery: d });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message });
  }
});

r.post("/gc", async (c) => c.json({ result: await runGc(c.env, { reconcile: true }) }));

export default r;
