// Short-lived internal tokens (OIDC state cookie, share unlock tokens), HS256 with a key
// derived from APP_SECRET.
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { deriveKey } from "./crypto";

export async function signJwt(secret: string, payload: JWTPayload, ttlSeconds: number): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(await deriveKey(secret, "jwt"));
}

export async function verifyJwt<T extends JWTPayload>(secret: string, token: string | undefined | null): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await deriveKey(secret, "jwt"), { algorithms: ["HS256"] });
    return payload as T;
  } catch {
    return null;
  }
}
