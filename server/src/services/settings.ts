// Runtime settings editable by admins, stored as JSON rows in `settings`.
import { all, now, run, type DB } from "../db";

export const GiB = 1024 ** 3;

export type Settings = {
  site: { name: string; default_quota_bytes: number };
  oidc: {
    enabled: boolean;
    issuer: string;
    client_id: string;
    /** Encrypted with APP_SECRET; never returned to clients. */
    client_secret: string;
    scopes: string;
    button_label: string;
    admin_group: string;
  };
  gc: { pending_upload_ttl_hours: number };
};

export const DEFAULT_SETTINGS: Settings = {
  site: { name: "blift", default_quota_bytes: 10 * GiB },
  oidc: {
    enabled: false,
    issuer: "",
    client_id: "",
    client_secret: "",
    scopes: "openid profile email",
    button_label: "SSO",
    admin_group: "",
  },
  gc: { pending_upload_ttl_hours: 24 },
};

export async function getSettings(db: DB): Promise<Settings> {
  const rows = await all<{ key: keyof Settings; value: string }>(db, "SELECT key, value FROM settings");
  const s = structuredClone(DEFAULT_SETTINGS) as Record<string, object>;
  for (const r of rows) if (r.key in s) s[r.key] = { ...s[r.key], ...JSON.parse(r.value) };
  return s as Settings;
}

export async function putSetting<K extends keyof Settings>(db: DB, key: K, value: Settings[K]): Promise<void> {
  await run(
    db,
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    JSON.stringify(value),
    now(),
  );
}
