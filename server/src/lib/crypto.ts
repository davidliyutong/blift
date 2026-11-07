// WebCrypto helpers that work identically on Workers and Node.
import { randomBytes } from "./ids";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const toHex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export const b64encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export const b64decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const safeEqual = (a: string, b: string) => timingSafeEqual(enc.encode(a), enc.encode(b));

// ---- Passwords: PBKDF2-SHA256. 100k iterations is the maximum Workers allows.
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const got = await pbkdf2(password, b64decode(salt), Number(iter));
  return timingSafeEqual(got, b64decode(hash));
}

// ---- Keys derived from APP_SECRET (one secret, separate purposes).
const keyCache = new Map<string, Promise<Uint8Array>>();

export function deriveKey(secret: string, purpose: "enc" | "jwt"): Promise<Uint8Array> {
  const id = `${purpose}:${secret}`;
  let k = keyCache.get(id);
  if (!k) {
    k = crypto.subtle.digest("SHA-256", enc.encode(`blift:${purpose}:${secret}`)).then((b) => new Uint8Array(b));
    keyCache.set(id, k);
  }
  return k;
}

async function aesKey(secret: string) {
  return crypto.subtle.importKey("raw", (await deriveKey(secret, "enc")) as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** AES-256-GCM; output `v1.<iv>.<ciphertext>` (base64). Used for credentials at rest. */
export async function encrypt(secret: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, await aesKey(secret), enc.encode(plaintext));
  return `v1.${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

export async function decrypt(secret: string, data: string): Promise<string> {
  const [v, iv, ct] = data.split(".");
  if (v !== "v1") throw new Error("unknown ciphertext version");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(iv) as BufferSource },
    await aesKey(secret),
    b64decode(ct) as BufferSource,
  );
  return dec.decode(pt);
}
