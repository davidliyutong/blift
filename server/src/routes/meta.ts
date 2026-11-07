import { Hono } from "hono";
import { createSession, requireUser, setSessionCookie } from "../auth";
import { all, now, one, run, type DB } from "../db";
import type { AppEnv, UserRow } from "../env";
import { hashPassword, safeEqual } from "../lib/crypto";
import { ApiError, conflict, notConfigured } from "../lib/errors";
import { body, likeArg, optStr, password, publicOrigin, str, usernameOf } from "../lib/http";
import { newId } from "../lib/ids";
import { getSettings } from "../services/settings";
import { toUser } from "../services/users";
import { VERSION } from "../version";

export const hasAdmin = async (db: DB) =>
  !!(await one(db, "SELECT 1 AS x FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1"));

const r = new Hono<AppEnv>();

r.get("/health", (c) => c.json({ ok: true }));

r.get("/info", async (c) => {
  const [s, admin] = await Promise.all([getSettings(c.env.DB), hasAdmin(c.env.DB)]);
  return c.json({
    name: s.site.name,
    version: VERSION,
    setup_required: !admin,
    oidc_enabled: s.oidc.enabled && !!s.oidc.issuer && !!s.oidc.client_id,
    oidc_button_label: s.oidc.button_label,
    public_url: publicOrigin(c),
  });
});

// One-off bootstrap: usable only while no active admin exists.
r.post("/setup", async (c) => {
  const b = await body(c);
  const expected = c.env.BOOTSTRAP_SECRET;
  if (!expected) throw notConfigured("BOOTSTRAP_SECRET is not set on the server");
  if (await hasAdmin(c.env.DB)) throw conflict("setup_done", "setup already completed");
  if (!safeEqual(str(b.secret, "secret", 512), expected)) throw new ApiError(403, "invalid_secret", "wrong bootstrap secret");
  const username = usernameOf(b.username);
  const pw = password(b.password);
  const email = optStr(b.email, "email", 254) ?? null;
  if (await one(c.env.DB, "SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE", username))
    throw conflict("name_taken", "username already exists");

  const id = newId();
  await run(
    c.env.DB,
    "INSERT INTO users (id, username, email, password_hash, role, quota_bytes, created_at, last_login_at) VALUES (?, ?, ?, ?, 'admin', -1, ?, ?)",
    id,
    username,
    email,
    await hashPassword(pw),
    now(),
    now(),
  );
  setSessionCookie(c, await createSession(c, id, "web", "setup", false));
  const user = await one<UserRow>(c.env.DB, "SELECT * FROM users WHERE id = ?", id);
  return c.json({ user: toUser(user!, await getSettings(c.env.DB)) }, 201);
});

r.get("/storages", async (c) => {
  requireUser(c);
  const storages = await all<{ id: string; name: string; provider: string; is_default: number }>(
    c.env.DB,
    "SELECT id, name, provider, is_default FROM storages ORDER BY is_default DESC, created_at",
  );
  return c.json({ storages: storages.map((s) => ({ ...s, is_default: !!s.is_default })) });
});

r.get("/users/search", async (c) => {
  requireUser(c);
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ users: [] });
  const like = likeArg(q);
  const users = await all(
    c.env.DB,
    `SELECT id, username, display_name, email FROM users
     WHERE status = 'active' AND (username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
     ORDER BY username LIMIT 10`,
    like,
    like,
    like,
  );
  return c.json({ users });
});

export default r;
