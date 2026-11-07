// Device-authorization flow for the CLI (same UX as `gh auth login`): the CLI gets a
// user code, the user approves it in the browser, the CLI polls and receives a token.
import { Hono } from "hono";
import { createSession, requireUser } from "../auth";
import { now, one, run } from "../db";
import type { AppEnv, UserRow } from "../env";
import { sha256Hex } from "../lib/crypto";
import { ApiError, notFound } from "../lib/errors";
import { body, optStr, publicOrigin, str } from "../lib/http";
import { newUserCode, randomString } from "../lib/ids";
import { getSettings } from "../services/settings";
import { toUser } from "../services/users";

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
