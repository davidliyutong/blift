// Sessions: an opaque random token (cookie for the web, Bearer for the CLI); only its
// SHA-256 is stored, so a database leak does not leak usable tokens.
import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { now, one, run } from "./db";
import type { AppEnv, Ctx, SessionInfo, UserRow } from "./env";
import { sha256Hex } from "./lib/crypto";
import { ApiError, forbidden, unauthorized } from "./lib/errors";
import { publicOrigin } from "./lib/http";
import { newToken } from "./lib/ids";

export const SESSION_COOKIE = "blift_session";
const DAY = 86_400_000;
const TTL = { web: 30 * DAY, cli: 90 * DAY };

export const isSecure = (c: Ctx) => publicOrigin(c).startsWith("https:");

export async function createSession(
  c: Ctx,
  userId: string,
  kind: "web" | "cli",
  name: string | null,
  mfaPending: boolean,
  apiKeyId: string | null = null,
): Promise<string> {
  const token = newToken();
  const t = now();
  await run(
    c.env.DB,
    "INSERT INTO sessions (id, user_id, kind, name, mfa_pending, created_at, expires_at, last_used_at, api_key_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    await sha256Hex(token),
    userId,
    kind,
    name,
    mfaPending,
    t,
    t + TTL[kind],
    t,
    apiKeyId,
  );
  return token;
}

export function setSessionCookie(c: Ctx, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    maxAge: TTL.web / 1000,
  });
}

export const clearSessionCookie = (c: Ctx) => deleteCookie(c, SESSION_COOKIE, { path: "/" });

/** Short description of the client for the sessions list, e.g. "Chrome on macOS". */
export function clientName(c: Ctx): string {
  const ua = c.req.header("user-agent") ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Resolves the caller (if any). Never rejects: guards below decide what is required. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const h = c.req.header("authorization");
  const token = h?.startsWith("Bearer ") ? h.slice(7).trim() : getCookie(c, SESSION_COOKIE);
  if (token) {
    const row = await one<UserRow & { s_id: string; s_kind: "web" | "cli"; s_mfa: number; s_exp: number; s_used: number }>(
      c.env.DB,
      `SELECT u.*, s.id AS s_id, s.kind AS s_kind, s.mfa_pending AS s_mfa, s.expires_at AS s_exp, s.last_used_at AS s_used
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      await sha256Hex(token),
    );
    if (row && row.s_exp > now() && row.status === "active") {
      const { s_id, s_kind, s_mfa, s_exp, s_used, ...user } = row;
      const session: SessionInfo = { id: s_id, kind: s_kind, mfa_pending: s_mfa, expires_at: s_exp, last_used_at: s_used };
      c.set("user", user);
      c.set("session", session);
      // Throttled to one write per 5 minutes per session.
      if (now() - s_used > 300_000)
        c.executionCtx.waitUntil(run(c.env.DB, "UPDATE sessions SET last_used_at = ? WHERE id = ?", now(), s_id));
    }
  }
  await next();
};

export function requireUser(c: Ctx): UserRow {
  const u = c.get("user");
  if (!u) throw unauthorized();
  if (c.get("session")?.mfa_pending) throw new ApiError(401, "mfa_required", "two-factor verification required");
  return u;
}

export function requireAdmin(c: Ctx): UserRow {
  const u = requireUser(c);
  if (u.role !== "admin") throw forbidden("admin only");
  return u;
}
