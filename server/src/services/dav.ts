// WebDAV sign-in: HTTP Basic with the username and a WebDAV password (table dav_passwords). A
// password can be limited to one project and to reading. A generated one is random, so its
// SHA-256 is enough and each request costs one lookup. One the user chose is hashed like an
// account password (PBKDF2, slow on purpose); a client makes hundreds of requests per sync, so a
// password that verified is remembered by its hash for a few minutes per isolate. The row is
// still read on every request: deleting a password works at once.
import { all, now, one, run } from "../db";
import type { Ctx, UserRow } from "../env";
import { b64decode, sha256Hex, verifyPassword } from "../lib/crypto";
import { DAV_PASSWORD_PREFIX } from "../lib/ids";

export type DavPassword = {
  id: string;
  user_id: string;
  name: string;
  secret_hash: string;
  generated: number;
  /** Only this project; null = every project the user can reach over WebDAV. */
  project_id: string | null;
  readonly: number;
  last_used_at: number | null;
  created_at: number;
};

const REMEMBER = 10 * 60_000;
const verified = new Map<string, { id: string; until: number }>();

export async function davCredential(c: Ctx): Promise<{ user: UserRow; password: DavPassword } | null> {
  const h = c.req.header("authorization") ?? "";
  if (!/^basic /i.test(h)) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(b64decode(h.slice(6).trim()));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 1) return null;
  const [username, secret] = [decoded.slice(0, colon), decoded.slice(colon + 1)];
  const db = c.env.DB;
  const user = await one<UserRow>(db, "SELECT * FROM users WHERE username = ? COLLATE NOCASE AND status = 'active'", username);
  if (!user || !secret) return null;

  let password: DavPassword | null = null;
  if (secret.startsWith(DAV_PASSWORD_PREFIX)) {
    password = await one<DavPassword>(db, "SELECT * FROM dav_passwords WHERE secret_hash = ? AND user_id = ? AND generated = 1", await sha256Hex(secret), user.id);
  } else {
    const key = await sha256Hex(`${user.id}\0${secret}`);
    const hit = verified.get(key);
    if (hit && hit.until > now()) {
      password = await one<DavPassword>(db, "SELECT * FROM dav_passwords WHERE id = ? AND user_id = ?", hit.id, user.id);
    } else {
      for (const row of await all<DavPassword>(db, "SELECT * FROM dav_passwords WHERE user_id = ? AND generated = 0 LIMIT 20", user.id)) {
        if (await verifyPassword(secret, row.secret_hash)) {
          password = row;
          if (verified.size > 1000) verified.clear();
          verified.set(key, { id: row.id, until: now() + REMEMBER });
          break;
        }
      }
    }
  }
  if (!password) return null;
  // One write per hour per password at most.
  if (now() - (password.last_used_at ?? 0) > 3_600_000)
    c.executionCtx.waitUntil(run(db, "UPDATE dav_passwords SET last_used_at = ? WHERE id = ?", now(), password.id));
  return { user, password };
}

export const toDavPassword = (p: DavPassword & { project_name?: string | null }) => ({
  id: p.id,
  name: p.name,
  generated: !!p.generated,
  project_id: p.project_id,
  project_name: p.project_name ?? null,
  readonly: !!p.readonly,
  last_used_at: p.last_used_at,
  created_at: p.created_at,
});
