// OpenID Connect relying party (authorization code + PKCE). Tuned for Authentik but
// provider-agnostic. ID tokens may be signed with HS256 (key = client secret, Authentik's
// default when no signing key is selected) or RS256/ES256 (verified against the JWKS).
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { ApiError } from "./errors";

export type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
};

export const oidcError = (message: string) => new ApiError(502, "oidc_error", message);

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function discover(issuer: string, fresh = false): Promise<Discovery> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const hit = discoveryCache.get(url);
  if (!fresh && hit && Date.now() - hit.at < 600_000) return hit.doc;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw oidcError(`discovery request failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw oidcError(`discovery failed: HTTP ${res.status} from ${url}`);
  const doc = (await res.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw oidcError("incomplete discovery document");
  discoveryCache.set(url, { at: Date.now(), doc });
  return doc;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function exchangeCode(
  d: Discovery,
  p: { code: string; redirectUri: string; clientId: string; clientSecret: string; verifier: string },
): Promise<{ id_token: string; access_token?: string }> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.verifier,
  });
  if (p.clientSecret) form.set("client_secret", p.clientSecret); // client_secret_post
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !json.id_token)
    throw oidcError(`token exchange failed: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  return json as { id_token: string; access_token?: string };
}

export async function verifyIdToken(
  idToken: string,
  d: Discovery,
  clientId: string,
  clientSecret: string,
  nonce: string,
): Promise<JWTPayload> {
  const { alg } = decodeProtectedHeader(idToken);
  const opts = { issuer: d.issuer, audience: clientId };
  let payload: JWTPayload;
  try {
    if (alg?.startsWith("HS")) {
      if (!clientSecret) throw new Error("HS-signed ID token but no client secret configured");
      payload = (await jwtVerify(idToken, new TextEncoder().encode(clientSecret), { ...opts, algorithms: [alg] })).payload;
    } else {
      let jwks = jwksCache.get(d.jwks_uri);
      if (!jwks) jwksCache.set(d.jwks_uri, (jwks = createRemoteJWKSet(new URL(d.jwks_uri))));
      payload = (await jwtVerify(idToken, jwks, opts)).payload;
    }
  } catch (e) {
    throw oidcError(`invalid ID token: ${(e as Error).message}`);
  }
  if (payload.nonce !== nonce) throw oidcError("ID token nonce mismatch");
  return payload;
}

export async function userinfo(d: Discovery, accessToken: string): Promise<Record<string, unknown>> {
  if (!d.userinfo_endpoint) return {};
  const res = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  return res.ok ? ((await res.json()) as Record<string, unknown>) : {};
}
