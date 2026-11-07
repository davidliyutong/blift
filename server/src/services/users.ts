import type { UserRow } from "../env";
import type { Settings } from "./settings";

export const effectiveQuota = (u: Pick<UserRow, "quota_bytes">, s: Settings) => u.quota_bytes ?? s.site.default_quota_bytes;

export function toUser(u: UserRow, s: Settings) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    quota_bytes: effectiveQuota(u, s),
    used_bytes: u.used_bytes,
    totp_enabled: !!u.totp_enabled,
    has_password: !!u.password_hash,
    oidc_linked: !!u.oidc_sub,
    created_at: u.created_at,
  };
}

export const userRef = (id: string | null, username: string | null, display_name: string | null) =>
  id && username ? { id, username, display_name } : null;

/** Throws-free check used before accepting new bytes. */
export function hasQuotaFor(u: Pick<UserRow, "quota_bytes" | "used_bytes">, s: Settings, bytes: number): boolean {
  const q = effectiveQuota(u, s);
  return q < 0 || u.used_bytes + bytes <= q;
}
