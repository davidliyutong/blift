// Schema migrations, applied automatically at startup (Node) or on the first request of a
// Worker isolate. Append new entries; never edit an applied one.
// No FOREIGN KEY constraints on purpose: deletes are asynchronous (GC) and D1 always
// enforces FKs, so referential cleanup is done explicitly in code.
import { all, type DB } from "./index";

export const migrations: { name: string; sql: string }[] = [
  {
    name: "0001_init",
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  password_hash TEXT,
  oidc_sub TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  quota_bytes INTEGER,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX users_username ON users(username COLLATE NOCASE);
CREATE UNIQUE INDEX users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;
CREATE INDEX users_email ON users(email COLLATE NOCASE);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  mfa_pending INTEGER NOT NULL DEFAULT 0,
  mfa_failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE cli_logins (
  id TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE storages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  region TEXT NOT NULL,
  bucket TEXT NOT NULL,
  access_key_id TEXT NOT NULL,
  secret_access_key TEXT NOT NULL,
  path_style INTEGER NOT NULL DEFAULT 1,
  prefix TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  blob_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX projects_owner_name ON projects(owner_id, name COLLATE NOCASE) WHERE status = 'active';
CREATE INDEX projects_status ON projects(status);

CREATE TABLE project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX members_user ON project_members(user_id);

CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  storage_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  status TEXT NOT NULL,
  upload_id TEXT,
  part_size INTEGER,
  overwrite INTEGER NOT NULL DEFAULT 0,
  uploader_id TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX blobs_project_name ON blobs(project_id, name) WHERE status = 'active';
CREATE INDEX blobs_project_status ON blobs(project_id, status);
CREATE INDEX blobs_status_updated ON blobs(status, updated_at);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  blob_id TEXT,
  creator_id TEXT NOT NULL,
  password_hash TEXT,
  expires_at INTEGER,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX shares_project ON shares(project_id);
CREATE INDEX shares_creator ON shares(creator_id);
CREATE INDEX shares_blob ON shares(blob_id);

CREATE TABLE stats_daily (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  requests INTEGER NOT NULL DEFAULT 0,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0,
  uploads INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);
`,
  },
  {
    // Listing a large project: one index per sort, so pages are read in index order instead of
    // sorting every file of the project on each request (see listBlobs). GC takes deleted files
    // one storage at a time (blobs_gc).
    name: "0002_list_indexes",
    sql: `
CREATE INDEX blobs_list_name ON blobs(project_id, name COLLATE NOCASE, id) WHERE status = 'active';
CREATE INDEX blobs_list_created ON blobs(project_id, created_at, id) WHERE status = 'active';
CREATE INDEX blobs_list_size ON blobs(project_id, size, id) WHERE status = 'active';
CREATE INDEX shares_expires ON shares(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX blobs_gc ON blobs(storage_id, updated_at) WHERE status = 'deleted';
`,
  },
  {
    // API keys: credentials that `blift login --api-key` exchanges for a CLI session (unattended
    // installs). Only the key's SHA-256 is stored; sessions remember the key they came from so
    // revoking a key can sign them out too.
    // Inboxes: a project with an inbox_token accepts anonymous uploads at /i/<token>.
    name: "0003_api_keys_inbox",
    sql: `
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  max_uses INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX api_keys_user ON api_keys(user_id);
CREATE INDEX api_keys_expires ON api_keys(expires_at) WHERE expires_at IS NOT NULL;
ALTER TABLE sessions ADD COLUMN api_key_id TEXT;
CREATE INDEX sessions_api_key ON sessions(api_key_id) WHERE api_key_id IS NOT NULL;
ALTER TABLE projects ADD COLUMN inbox_token TEXT;
CREATE UNIQUE INDEX projects_inbox ON projects(inbox_token) WHERE inbox_token IS NOT NULL;
ALTER TABLE blobs ADD COLUMN via_inbox INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    // Lifetime (seconds) of the CLI sessions an API key creates; NULL = until revoked. Existing
    // keys keep the device-flow lifetime of 90 days.
    name: "0004_api_key_session_ttl",
    sql: `
ALTER TABLE api_keys ADD COLUMN session_ttl INTEGER DEFAULT 7776000;
`,
  },
  {
    // A storage backend's location: a free-text label for users ("Singapore", "US West"), unlike
    // `region`, which is the S3 signing region ("auto", "us-east-1").
    name: "0005_storage_location",
    sql: `
ALTER TABLE storages ADD COLUMN location TEXT NOT NULL DEFAULT '';
`,
  },
];

const split = (sql: string) =>
  sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Applies pending migrations. Each migration runs in one batch (= one transaction). */
export async function migrate(db: DB): Promise<void> {
  await db.prepare("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)").run();
  const done = new Set((await all<{ name: string }>(db, "SELECT name FROM _migrations")).map((r) => r.name));
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    const stmts = split(m.sql).map((s) => db.prepare(s));
    stmts.push(db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").bind(m.name, Date.now()));
    try {
      await db.batch(stmts);
    } catch (e) {
      // Another isolate may have applied it concurrently; only rethrow if it is still missing.
      const row = await db.prepare("SELECT 1 AS x FROM _migrations WHERE name = ?").bind(m.name).first();
      if (!row) throw e;
    }
  }
}

let migrated: Promise<void> | null = null;

/** Memoized per process / isolate. */
export function ensureMigrated(db: DB): Promise<void> {
  migrated ??= migrate(db).catch((e) => {
    migrated = null;
    throw e;
  });
  return migrated;
}
