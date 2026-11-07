// Request parsing / validation helpers. Validation is intentionally minimal: check what the
// database or S3 cannot check for us and fail with a readable `bad_request`.
import type { Ctx } from "../env";
import { badRequest } from "./errors";

export async function body<T = Record<string, unknown>>(c: Ctx): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest("invalid JSON body");
  }
}

export function str(v: unknown, field: string, max = 255): string {
  if (typeof v !== "string" || !v.trim()) throw badRequest(`${field} is required`);
  if (v.length > max) throw badRequest(`${field} is too long (max ${max})`);
  return v.trim();
}

export function optStr(v: unknown, field: string, max = 255): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return str(v, field, max);
}

export function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "string" && v !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
    throw badRequest(`${field} must be an integer in [${min}, ${max}]`);
  return n;
}

export function oneOf<T extends string>(v: unknown, field: string, values: readonly T[]): T {
  if (!values.includes(v as T)) throw badRequest(`${field} must be one of ${values.join(", ")}`);
  return v as T;
}

export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;

export function projectName(v: unknown): string {
  const s = str(v, "name", 64);
  if (!PROJECT_NAME_RE.test(s)) throw badRequest("project name may only contain letters, digits, '.', '_' and '-'");
  return s;
}

export function blobName(v: unknown): string {
  if (typeof v !== "string") throw badRequest("name is required");
  const s = v.normalize("NFC");
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > 255 || /[/\\\u0000-\u001f\u007f]/.test(s) || s === "." || s === "..")
    throw badRequest("invalid file name (1-255 chars, no '/', '\\' or control characters)");
  return s;
}

export function usernameOf(v: unknown): string {
  const s = str(v, "username", 32);
  if (!USERNAME_RE.test(s)) throw badRequest("username must be 2-32 chars: letters, digits, '.', '_', '-'");
  return s;
}

export function password(v: unknown, field = "password"): string {
  if (typeof v !== "string" || v.length < 8 || v.length > 256) throw badRequest(`${field} must be 8-256 characters`);
  return v;
}

/** Escape LIKE wildcards; use with `ESCAPE '\\'`. */
export const likeArg = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** Origin used for links we hand out (share URLs, OIDC redirect URI, CLI verification URL). */
export function publicOrigin(c: Ctx): string {
  if (c.env.PUBLIC_URL) return c.env.PUBLIC_URL.replace(/\/+$/, "");
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim() || u.protocol.slice(0, -1);
  const host = c.req.header("x-forwarded-host")?.split(",")[0].trim() || u.host;
  return `${proto}://${host}`;
}

/** Only same-site relative paths, to avoid open redirects. */
export const safeRedirect = (r: string | undefined) =>
  r && r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/\\") ? r : "/";

/** Run `fn` over items with bounded concurrency (Workers allow 6 concurrent connections). */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
