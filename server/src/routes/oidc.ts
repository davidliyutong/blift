import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { JWTPayload } from "jose";
import { clientName, createSession, isSecure, setSessionCookie } from "../auth";
import { now, one, run, type DB } from "../db";
import type { AppEnv, Ctx, UserRow } from "../env";
import { decrypt } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { publicOrigin, safeRedirect, USERNAME_RE } from "../lib/http";
import { newId, randomString } from "../lib/ids";
import { signJwt, verifyJwt } from "../lib/jwt";
import { discover, exchangeCode, pkceChallenge, userinfo, verifyIdToken } from "../lib/oidc";
import { getSettings, type Settings } from "../services/settings";

const STATE_COOKIE = "blift_oidc";
const STATE_PATH = "/api/auth/oidc";

export const redirectUri = (c: Ctx) => `${publicOrigin(c)}/api/auth/oidc/callback`;
export const oidcReady = (o: Settings["oidc"]) => o.enabled && !!o.issuer && !!o.client_id;

type State = JWTPayload & { state: string; nonce: string; verifier: string; redirect: string };

const r = new Hono<AppEnv>();

r.get("/start", async (c) => {
  // Browser navigation: report problems on the login page rather than as JSON.
  const { oidc } = await getSettings(c.env.DB);
  if (!oidcReady(oidc)) return c.redirect("/login?error=not_configured");
  const d = await discover(oidc.issuer).catch((e) => (console.error("oidc discovery:", e), null));
  if (!d) return c.redirect("/login?error=oidc_error");
  const st: State = {
    state: randomString(24),
    nonce: randomString(24),
    verifier: randomString(64),
    redirect: safeRedirect(c.req.query("redirect")),
  };
  setCookie(c, STATE_COOKIE, await signJwt(c.env.APP_SECRET, st, 600), {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: STATE_PATH,
    maxAge: 600,
  });
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: oidc.client_id,
    redirect_uri: redirectUri(c),
    scope: oidc.scopes,
    state: st.state,
    nonce: st.nonce,
    code_challenge: await pkceChallenge(st.verifier),
    code_challenge_method: "S256",
  }).toString();
  return c.redirect(u.toString());
});

r.get("/callback", async (c) => {
  const st = await verifyJwt<State>(c.env.APP_SECRET, getCookie(c, STATE_COOKIE));
  deleteCookie(c, STATE_COOKIE, { path: STATE_PATH });
  const fail = (code: string) => c.redirect(`/login?error=${code}`);
  if (!st || st.state !== c.req.query("state")) return fail("oidc_error");
  if (c.req.query("error") || !c.req.query("code")) return fail("access_denied");

  try {
    const s = await getSettings(c.env.DB);
    const o = s.oidc;
    if (!oidcReady(o)) return fail("not_configured");
    const d = await discover(o.issuer);
    const secret = o.client_secret ? await decrypt(c.env.APP_SECRET, o.client_secret) : "";
    const tokens = await exchangeCode(d, {
      code: c.req.query("code")!,
      redirectUri: redirectUri(c),
      clientId: o.client_id,
      clientSecret: secret,
      verifier: st.verifier,
    });
    const idClaims = await verifyIdToken(tokens.id_token, d, o.client_id, secret, st.nonce);
    const info = tokens.access_token ? await userinfo(d, tokens.access_token) : {};
    // Verified ID-token claims win over userinfo for identity.
    const claims = { ...info, ...idClaims, groups: idClaims.groups ?? info.groups };
    const user = await upsertOidcUser(c.env.DB, s, claims);
    if (user.status !== "active") return fail("account_disabled");

    const pending = !!user.totp_enabled;
    setSessionCookie(c, await createSession(c, user.id, "web", clientName(c), pending));
    return c.redirect(pending ? `/login?mfa=1&redirect=${encodeURIComponent(st.redirect)}` : st.redirect);
  } catch (e) {
    console.error("oidc callback:", e);
    return fail(e instanceof ApiError ? e.code : "oidc_error");
  }
});

/**
 * Finds the user by `sub`, else links a password account with the same email (the IdP is
 * the organisation's own and trusted), else auto-registers a new user.
 */
async function upsertOidcUser(db: DB, s: Settings, claims: Record<string, unknown>): Promise<UserRow> {
  const sub = String(claims.sub);
  const email = typeof claims.email === "string" ? claims.email : null;
  const name = typeof claims.name === "string" ? claims.name : null;
  const groups = Array.isArray(claims.groups) ? claims.groups.map(String) : [];
  const makeAdmin = !!s.oidc.admin_group && groups.includes(s.oidc.admin_group);

  let u = await one<UserRow>(db, "SELECT * FROM users WHERE oidc_sub = ?", sub);
  if (!u && email) u = await one<UserRow>(db, "SELECT * FROM users WHERE oidc_sub IS NULL AND email = ? COLLATE NOCASE", email);

  if (u) {
    await run(
      db,
      `UPDATE users SET oidc_sub = ?, email = COALESCE(?, email), display_name = COALESCE(?, display_name),
         role = CASE WHEN ? THEN 'admin' ELSE role END, last_login_at = ? WHERE id = ?`,
      sub,
      email,
      name,
      makeAdmin,
      now(),
      u.id,
    );
  } else {
    const preferred = String(claims.preferred_username ?? claims.nickname ?? email?.split("@")[0] ?? sub);
    const id = newId();
    await run(
      db,
      "INSERT INTO users (id, username, email, display_name, oidc_sub, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      await uniqueUsername(db, preferred),
      email,
      name,
      sub,
      makeAdmin ? "admin" : "user",
      now(),
      now(),
    );
    u = { id } as UserRow;
  }
  return (await one<UserRow>(db, "SELECT * FROM users WHERE id = ?", u.id))!;
}

async function uniqueUsername(db: DB, wanted: string): Promise<string> {
  let base = wanted.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 28);
  if (!USERNAME_RE.test(base)) base = `user-${randomString(6).toLowerCase()}`;
  for (let i = 1; i < 50; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (!(await one(db, "SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE", candidate))) return candidate;
  }
  return `${base}-${randomString(4).toLowerCase()}`;
}

export default r;
