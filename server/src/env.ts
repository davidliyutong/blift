import type { Context } from "hono";
import type { DB } from "./db";

export type Bindings = {
  DB: DB;
  /** Signs cookies/tokens and encrypts credentials at rest. Required. */
  APP_SECRET: string;
  /** One-off secret that allows creating the first admin (only while no admin exists). */
  BOOTSTRAP_SECRET?: string;
  /** Public origin, e.g. https://files.example.com. Defaults to the request origin. */
  PUBLIC_URL?: string;
  /** Max S3 requests per GC run (Workers free plan: 50 subrequests per invocation). */
  GC_BUDGET?: string;
};

export type Role = "admin" | "user";

export type UserRow = {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  password_hash: string | null;
  oidc_sub: string | null;
  role: Role;
  status: "active" | "disabled";
  quota_bytes: number | null;
  used_bytes: number;
  totp_secret: string | null;
  totp_enabled: number;
  created_at: number;
  last_login_at: number | null;
};

export type SessionInfo = {
  id: string;
  kind: "web" | "cli";
  mfa_pending: number;
  expires_at: number;
  last_used_at: number;
};

export type StatDelta = Partial<Record<"requests" | "upload_bytes" | "download_bytes" | "uploads" | "downloads", number>>;

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    user?: UserRow;
    session?: SessionInfo;
    /** Counters flushed to stats_daily once per request (see services/stats.ts). */
    stats: StatDelta;
    /** Overrides the user the stats are attributed to (e.g. share downloads → project owner). */
    statsUser?: string;
  };
};

export type Ctx = Context<AppEnv>;
