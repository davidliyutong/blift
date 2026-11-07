import { Hono } from "hono";
import { clearSessionCookie, clientName, createSession, requireUser, setSessionCookie } from "../auth";
import { all, now, one, run } from "../db";
import type { AppEnv, UserRow } from "../env";
import { decrypt, encrypt, hashPassword, verifyPassword } from "../lib/crypto";
import { ApiError, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import { body, password, str } from "../lib/http";
import { newTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp";
import { getSettings } from "../services/settings";
import { toUser } from "../services/users";

const MAX_MFA_FAILURES = 5;
const invalidCode = () => new ApiError(400, "invalid_code", "wrong verification code");

const r = new Hono<AppEnv>();

r.post("/login", async (c) => {
  const b = await body(c);
  const login = str(b.username, "username", 254);
  const pw = str(b.password, "password", 256);
  const u = await one<UserRow>(
    c.env.DB,
    "SELECT * FROM users WHERE username = ? COLLATE NOCASE OR (email = ? COLLATE NOCASE AND password_hash IS NOT NULL) LIMIT 1",
    login,
    login,
  );
  if (!u || !(await verifyPassword(pw, u.password_hash)))
    throw new ApiError(401, "invalid_credentials", "wrong username or password");
  if (u.status !== "active") throw new ApiError(403, "account_disabled", "account disabled");

  const pending = !!u.totp_enabled;
  setSessionCookie(c, await createSession(c, u.id, "web", clientName(c), pending));
  if (!pending) await run(c.env.DB, "UPDATE users SET last_login_at = ? WHERE id = ?", now(), u.id);
  return c.json({ user: toUser(u, await getSettings(c.env.DB)), mfa_required: pending });
});

// Completes a session that is waiting for the TOTP step (password or OIDC login).
r.post("/mfa", async (c) => {
  const u = c.get("user");
  const sess = c.get("session");
  if (!u || !sess) throw unauthorized();
  const s = await getSettings(c.env.DB);
  if (!sess.mfa_pending) return c.json({ user: toUser(u, s) });

  const code = str((await body(c)).code, "code", 16);
  if (!u.totp_secret || !(await verifyTotp(await decrypt(c.env.APP_SECRET, u.totp_secret), code))) {
    const fails = await one<{ mfa_failures: number }>(
      c.env.DB,
      "UPDATE sessions SET mfa_failures = mfa_failures + 1 WHERE id = ? RETURNING mfa_failures",
      sess.id,
    );
    if ((fails?.mfa_failures ?? 0) >= MAX_MFA_FAILURES) {
      // Too many guesses: throw the session away so the attacker has to pass the first factor again.
      await run(c.env.DB, "DELETE FROM sessions WHERE id = ?", sess.id);
      clearSessionCookie(c);
      throw unauthorized("too many invalid codes, please sign in again");
    }
    throw invalidCode();
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE sessions SET mfa_pending = 0, mfa_failures = 0 WHERE id = ?").bind(sess.id),
    c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now(), u.id),
  ]);
  return c.json({ user: toUser(u, s) });
});

r.post("/logout", async (c) => {
  const sess = c.get("session");
  if (sess) await run(c.env.DB, "DELETE FROM sessions WHERE id = ?", sess.id);
  clearSessionCookie(c);
  return c.body(null, 204);
});

r.get("/me", async (c) => {
  const u = c.get("user");
  if (!u) throw unauthorized();
  return c.json({ user: toUser(u, await getSettings(c.env.DB)), mfa_pending: !!c.get("session")?.mfa_pending });
});

// ---- TOTP management

r.post("/totp/setup", async (c) => {
  const u = requireUser(c);
  if (u.totp_enabled) throw conflict("conflict", "two-factor authentication is already enabled");
  const secret = newTotpSecret();
  await run(c.env.DB, "UPDATE users SET totp_secret = ? WHERE id = ?", await encrypt(c.env.APP_SECRET, secret), u.id);
  const s = await getSettings(c.env.DB);
  return c.json({ secret, otpauth_url: otpauthUrl(secret, u.username, s.site.name) });
});

r.post("/totp/enable", async (c) => {
  const u = requireUser(c);
  const code = str((await body(c)).code, "code", 16);
  if (u.totp_enabled) throw conflict("conflict", "two-factor authentication is already enabled");
  if (!u.totp_secret) throw conflict("conflict", "call /api/auth/totp/setup first");
  if (!(await verifyTotp(await decrypt(c.env.APP_SECRET, u.totp_secret), code))) throw invalidCode();
  await run(c.env.DB, "UPDATE users SET totp_enabled = 1 WHERE id = ?", u.id);
  return c.body(null, 204);
});

r.post("/totp/disable", async (c) => {
  const u = requireUser(c);
  const code = str((await body(c)).code, "code", 16);
  if (!u.totp_enabled || !u.totp_secret) throw conflict("conflict", "two-factor authentication is not enabled");
  if (!(await verifyTotp(await decrypt(c.env.APP_SECRET, u.totp_secret), code))) throw invalidCode();
  await run(c.env.DB, "UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?", u.id);
  return c.body(null, 204);
});

// ---- Local password (bootstrap admin, or admins adding a fallback login)

r.post("/password", async (c) => {
  const u = requireUser(c);
  const b = await body(c);
  if (u.password_hash) {
    if (!(await verifyPassword(String(b.current_password ?? ""), u.password_hash)))
      throw new ApiError(401, "invalid_credentials", "current password is wrong");
  } else if (u.role !== "admin") {
    throw forbidden("only admins can add a local password");
  }
  const hash = await hashPassword(password(b.new_password, "new_password"));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(hash, u.id),
    // Sign out everywhere else.
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(u.id, c.get("session")!.id),
  ]);
  return c.body(null, 204);
});

// ---- Sessions (web logins and CLI tokens)

r.get("/sessions", async (c) => {
  const u = requireUser(c);
  const current = c.get("session")!.id;
  const rows = await all<{ id: string; kind: string; name: string | null; created_at: number; last_used_at: number; expires_at: number }>(
    c.env.DB,
    "SELECT id, kind, name, created_at, last_used_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? AND mfa_pending = 0 ORDER BY last_used_at DESC",
    u.id,
    now(),
  );
  return c.json({ sessions: rows.map((s) => ({ ...s, current: s.id === current })) });
});

r.delete("/sessions/:id", async (c) => {
  const u = requireUser(c);
  const n = await run(c.env.DB, "DELETE FROM sessions WHERE id = ? AND user_id = ?", c.req.param("id"), u.id);
  if (!n) throw notFound("session");
  if (c.req.param("id") === c.get("session")!.id) clearSessionCookie(c);
  return c.body(null, 204);
});

export default r;
