// Device-authorization flow for the CLI: the CLI gets a user code, the user approves it in the
// browser, the CLI polls and receives a token.
import { Hono } from "hono";
import { createSession, requireUser } from "../auth";
import { now, one, run } from "../db";
import type { AppEnv, UserRow } from "../env";
import { sha256Hex } from "../lib/crypto";
import { ApiError, notFound } from "../lib/errors";
import { body, optStr, publicOrigin, str } from "../lib/http";
import { newUserCode, randomString } from "../lib/ids";
import { installScript, RELEASE_DOWNLOADS, RELEASES } from "../lib/install";
import { getSettings } from "../services/settings";
import { toUser } from "../services/users";
import { VERSION } from "../version";

const TTL = 600_000;
const INTERVAL = 3;

type LoginRow = {
  id: string;
  user_code: string;
  client_name: string;
  status: "pending" | "approved" | "denied" | "consumed";
  user_id: string | null;
  created_at: number;
  expires_at: number;
};

const oauthError = (code: string, message: string) => new ApiError(400, code, message);

const r = new Hono<AppEnv>();

// Also served at /install.sh (see ALIASES in app.ts).
r.get("/install.sh", (c) =>
  c.body(installScript(publicOrigin(c), VERSION), 200, { "content-type": "text/plain; charset=utf-8" }),
);

// The latest published CLI release, for `blift update` on machines that cannot reach GitHub.
// GitHub's /releases/latest page redirects to the tag (no API rate limit); the answer is kept
// for an hour per isolate / process.
let latest: { version: string; until: number } | null = null;

r.get("/latest", async (c) => {
  if (!latest || latest.until < Date.now()) {
    const res = await fetch(`${RELEASES}/latest`, { redirect: "manual", headers: { "user-agent": `blift-server/${VERSION}` } });
    const tag = /\/releases\/tag\/v(\d+\.\d+\.\d+[0-9A-Za-z.-]*)$/.exec(res.headers.get("location") ?? "")?.[1];
    if (!tag) throw new ApiError(502, "upstream_error", `GitHub Releases answered HTTP ${res.status}`);
    latest = { version: tag, until: Date.now() + 3_600_000 };
  }
  return c.json({ version: latest.version });
});

// CLI release files relayed from GitHub Releases, for clients that cannot reach GitHub (install.sh
// tries this first). Only blift's own release files, which never change once published; Workers
// keep them in the edge cache, so GitHub is asked about once per file and data center.
const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;
const ARCHIVE = /^blift_(.+)_(linux|darwin)_(amd64|arm64)\.tar\.gz$/;

r.get("/download/:tag/:file", async (c) => {
  const { tag, file } = c.req.param();
  const version = TAG.exec(tag)?.[1];
  if (!version || (file !== "SHA256SUMS" && ARCHIVE.exec(file)?.[1] !== version)) throw notFound("release file");

  const cache = typeof caches === "undefined" ? undefined : await caches.open("cli-releases"); // Workers only
  const key = new Request(new URL(c.req.path, c.req.url));
  const hit = await cache?.match(key);
  if (hit) return new Response(hit.body, hit); // mutable headers for the middleware

  const res = await fetch(`${RELEASE_DOWNLOADS}/${tag}/${file}`, { headers: { "user-agent": `blift-server/${VERSION}` } });
  if (res.status === 404) throw notFound("release file");
  if (!res.ok || !res.body) throw new ApiError(502, "upstream_error", `GitHub Releases answered HTTP ${res.status}`);
  const headers = new Headers({
    "content-type": file === "SHA256SUMS" ? "text/plain; charset=utf-8" : "application/gzip",
    "cache-control": "public, max-age=31536000, immutable",
  });
  const length = res.headers.get("content-length");
  if (length) headers.set("content-length", length);
  const out = new Response(res.body, { headers });
  if (cache) c.executionCtx.waitUntil(cache.put(key, out.clone()));
  return out;
});

r.post("/login", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const clientName = optStr(b.client_name, "client_name", 100) ?? "blift-cli";
  const deviceCode = randomString(40);
  const userCode = newUserCode();
  const t = now();
  await run(
    c.env.DB,
    "INSERT INTO cli_logins (id, user_code, client_name, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    await sha256Hex(deviceCode),
    userCode,
    clientName,
    t,
    t + TTL,
  );
  const origin = publicOrigin(c);
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_url: `${origin}/cli`,
    verification_url_complete: `${origin}/cli?code=${userCode}`,
    interval: INTERVAL,
    expires_in: TTL / 1000,
  });
});

r.post("/login/poll", async (c) => {
  const deviceCode = str((await body(c)).device_code, "device_code", 128);
  const row = await one<LoginRow>(c.env.DB, "SELECT * FROM cli_logins WHERE id = ?", await sha256Hex(deviceCode));
  if (!row || row.expires_at < now() || row.status === "consumed") throw oauthError("expired_token", "login request expired");
  if (row.status === "denied") throw oauthError("access_denied", "login request was denied");
  if (row.status === "pending") throw oauthError("authorization_pending", "waiting for approval in the browser");

  // Approved: hand out the token exactly once.
  if (!(await run(c.env.DB, "UPDATE cli_logins SET status = 'consumed' WHERE id = ? AND status = 'approved'", row.id)))
    throw oauthError("expired_token", "login request already used");
  const user = await one<UserRow>(c.env.DB, "SELECT * FROM users WHERE id = ? AND status = 'active'", row.user_id);
  if (!user) throw oauthError("access_denied", "account disabled");
  const token = await createSession(c, user.id, "cli", row.client_name, false);
  return c.json({ token, user: toUser(user, await getSettings(c.env.DB)) });
});

// Unattended login with an API key (Account → API keys): `blift login --api-key`, or install.sh
// with BLIFT_API_KEY. Each use creates a CLI session linked to the key.
r.post("/login/api-key", async (c) => {
  const b = await body(c);
  const key = str(b.api_key, "api_key", 128);
  const clientName = optStr(b.client_name, "client_name", 100) ?? "blift-cli";
  const db = c.env.DB;
  const t = now();
  const invalid = () => new ApiError(401, "invalid_api_key", "API key is invalid, expired or used up");
  const row = await one<UserRow & { key_id: string; key_session_ttl: number | null }>(
    db,
    `SELECT u.*, k.id AS key_id, k.session_ttl AS key_session_ttl FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND (k.expires_at IS NULL OR k.expires_at > ?) AND (k.max_uses IS NULL OR k.use_count < k.max_uses)`,
    await sha256Hex(key),
    t,
  );
  if (!row) throw invalid();
  const { key_id: keyId, key_session_ttl: ttl, ...user } = row;
  if (user.status !== "active") throw new ApiError(403, "account_disabled", "account disabled");
  // Count the use first; the WHERE clause enforces max_uses atomically.
  if (!(await run(db, "UPDATE api_keys SET use_count = use_count + 1, last_used_at = ? WHERE id = ? AND (max_uses IS NULL OR use_count < max_uses)", t, keyId)))
    throw invalid();
  const token = await createSession(c, user.id, "cli", clientName, false, { apiKeyId: keyId, ttl: ttl == null ? null : ttl * 1000 });
  c.set("statsUser", user.id);
  return c.json({ token, user: toUser(user, await getSettings(db)) });
});

const findPending = async (c: Parameters<typeof requireUser>[0]) => {
  const code = c.req.param("code")!.toUpperCase();
  const row = await one<LoginRow>(c.env.DB, "SELECT * FROM cli_logins WHERE user_code = ?", code);
  if (!row || row.expires_at < now()) throw notFound("login request");
  return row;
};

r.get("/login/:code", async (c) => {
  requireUser(c);
  const row = await findPending(c);
  return c.json({
    user_code: row.user_code,
    client_name: row.client_name,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
  });
});

r.post("/login/:code/approve", async (c) => {
  const u = requireUser(c);
  const row = await findPending(c);
  if (!(await run(c.env.DB, "UPDATE cli_logins SET status = 'approved', user_id = ? WHERE id = ? AND status = 'pending'", u.id, row.id)))
    throw notFound("pending login request");
  return c.body(null, 204);
});

r.post("/login/:code/deny", async (c) => {
  requireUser(c);
  const row = await findPending(c);
  await run(c.env.DB, "UPDATE cli_logins SET status = 'denied' WHERE id = ? AND status = 'pending'", row.id);
  return c.body(null, 204);
});

export default r;
