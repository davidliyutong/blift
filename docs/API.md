# blift HTTP API (v1)

This document is the **contract** between the server (`server/`), the web UI (`web/`)
and the CLI (`cli/`). Change it together with the code.

## Conventions

- Base path: `/api`. Request and response bodies are JSON (`Content-Type: application/json`).
- Authentication (either):
  - Cookie `blift_session=<token>` (web, `HttpOnly; SameSite=Lax`).
  - Header `Authorization: Bearer <token>` (CLI). Tokens look like `blift_<32 base62 chars>`.
- Timestamps are **unix milliseconds** (integers). Sizes are **bytes** (integers).
- IDs are opaque strings (16 lowercase base32 chars).
- Errors always use a non-2xx status and this body:

  ```json
  { "error": { "code": "not_found", "message": "project not found" } }
  ```

  Clients translate `code` for display; `message` is English debug text.

| code | status | meaning |
| --- | --- | --- |
| `bad_request` | 400 | invalid input (`message` says what) |
| `unauthorized` | 401 | not logged in / token invalid or expired |
| `mfa_required` | 401 | session exists but TOTP step is pending |
| `invalid_credentials` | 401 | wrong username/password |
| `invalid_code` | 400 | wrong TOTP code |
| `forbidden` | 403 | logged in but not allowed |
| `account_disabled` | 403 | user disabled by admin |
| `quota_exceeded` | 403 | upload would exceed user quota |
| `invalid_secret` | 403 | wrong bootstrap secret |
| `invalid_api_key` | 401 | API key unknown, expired or used up (`/api/cli/login/api-key`) |
| `invalid_password` | 403 | wrong share password |
| `not_found` | 404 | resource not found (or not visible) |
| `conflict` | 409 | generic conflict |
| `name_taken` | 409 | a project/blob with that name already exists |
| `setup_done` | 409 | bootstrap already completed |
| `share_expired` | 410 | share expired |
| `share_exhausted` | 410 | share reached its download limit |
| `authorization_pending` | 400 | CLI login not approved yet (poll again) |
| `access_denied` | 400 | CLI login denied |
| `expired_token` | 400 | CLI login request expired |
| `not_configured` | 503 | storage / OIDC / bootstrap secret not configured |
| `storage_error` | 502 | the S3 backend returned an error (`message` has details) |
| `upstream_error` | 502 | GitHub Releases could not be reached (CLI download relay) |
| `oidc_error` | 502 | OIDC provider error |
| `internal` | 500 | bug |

## Object shapes

```ts
type User = {
  id: string; username: string; email: string | null; display_name: string | null;
  role: "admin" | "user";
  quota_bytes: number;      // effective quota, -1 = unlimited
  used_bytes: number;
  totp_enabled: boolean;
  has_password: boolean;    // local password login possible
  oidc_linked: boolean;
  created_at: number;
};

type UserRef = { id: string; username: string; display_name: string | null };

type Project = {
  id: string; name: string; description: string;
  owner: UserRef;
  role: "owner" | "editor" | "viewer";   // caller's role
  storage_id: string; storage_name: string;
  used_bytes: number; blob_count: number;
  inbox_enabled: boolean;                // accepts anonymous uploads (see "Inbox")
  inbox_url: string | null;              // <public origin>/i/<token>; only for editors and owners
  created_at: number; updated_at: number;
};

type Blob = {
  id: string; project_id: string; name: string; size: number;
  content_type: string;                  // "application/octet-stream" if unknown
  uploader: UserRef | null;
  via_inbox: boolean;                    // uploaded anonymously through the project inbox
  download_count: number;
  created_at: number; updated_at: number;
};

type Share = {
  id: string; token: string; url: string;        // url = <public origin>/s/<token>
  project_id: string; project_name: string;
  blob_id: string | null; blob_name: string | null;  // null = whole project
  has_password: boolean;
  expires_at: number | null; max_downloads: number | null;
  download_count: number; view_count: number;
  creator: UserRef; created_at: number;
};
```

Naming rules:
- Project name: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, unique per owner.
- Blob name: 1–255 chars, no `/`, `\`, control chars, not `.`/`..`; unique per project.
  The structure is deliberately flat: **project → blob**, no folders.

## Meta

`GET /api/health` → `{ "ok": true }`

`GET /api/info` (no auth)
```json
{ "name": "blift", "version": "0.1.0", "setup_required": false,
  "oidc_enabled": true, "oidc_button_label": "Authentik", "public_url": "https://files.example.com" }
```

## Bootstrap (one-off)

`POST /api/setup` (no auth) — only works while no admin exists.
Body `{ "secret": "...", "username": "admin", "password": "...", "email": "a@b.c" }`
→ `{ "user": User }` and sets the session cookie.
Errors: `setup_done`, `invalid_secret`, `not_configured` (server has no `BOOTSTRAP_SECRET`).

## Auth

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | `{username, password}` | `{user, mfa_required}` + cookie |
| POST | `/api/auth/mfa` | `{code}` | `{user}` (completes a pending-MFA session) |
| POST | `/api/auth/logout` | – | 204 |
| GET | `/api/auth/me` | – | `{user, mfa_pending}` |
| GET | `/api/auth/oidc/start?redirect=/path` | – | 302 to the IdP |
| GET | `/api/auth/oidc/callback` | – | 302 to `redirect` (or `/login?mfa=1&redirect=…`, or `/login?error=<code>`) |
| POST | `/api/auth/totp/setup` | – | `{secret, otpauth_url}` (pending until enabled) |
| POST | `/api/auth/totp/enable` | `{code}` | 204 |
| POST | `/api/auth/totp/disable` | `{code}` | 204 |
| POST | `/api/auth/password` | `{current_password?, new_password}` | 204 |
| GET | `/api/auth/sessions` | – | `{sessions: [{id, kind: "web"\|"cli", name, created_at, last_used_at, expires_at, current, api_key_name}]}` |
| DELETE | `/api/auth/sessions/:id` | – | 204 |
| GET | `/api/auth/api-keys` | – | `{api_keys: ApiKey[]}` |
| POST | `/api/auth/api-keys` | `{name, max_uses?, expires_in?}` | `ApiKey & {key}` (201) |
| DELETE | `/api/auth/api-keys/:id?revoke_sessions=1` | – | 204 |

A session whose user has TOTP enabled starts in *pending MFA* state (both local password
login and OIDC login). While pending, every endpoint except `/api/auth/mfa`, `/api/auth/me`
and `/api/auth/logout` returns `401 mfa_required`.

**API keys** let the CLI sign in without a browser (servers, scripts): `blift login --api-key`
or `BLIFT_API_KEY`, and `install.sh` (see below). Each use creates a 90-day CLI session; the key
is only a way to obtain one.

```ts
type ApiKey = {
  id: string; name: string;
  prefix: string;                 // first characters of the key, e.g. "bliftk_AbCd"
  max_uses: number | null;        // null = unlimited; 1 = single use
  use_count: number;
  expires_at: number | null;      // null = never
  last_used_at: number | null; created_at: number;
  session_count: number;          // active CLI sessions created with this key
};
```
Keys look like `bliftk_<32 base62 chars>`. Only their SHA-256 is stored: `key` is returned once, by
the POST. `max_uses` 1–1 000 000 or null, `expires_in` seconds (60 s – 10 years) or null. A key
does not need a second factor (the user created it while signed in). `revoke_sessions=1` also
signs out the CLI sessions created with the key. Expired keys are removed by GC after 7 days.

OIDC: users are auto-registered on first login (matched by `sub`). ID tokens signed with
**HS256** (key = client secret) and **RS256/ES256** (JWKS) are accepted. If the admin sets
`admin_group`, members of that group (from the `groups` claim) become admins.

## CLI installer

`GET /api/cli/install.sh`, also served at `/install.sh` (no auth) → `text/plain` POSIX sh script for
`curl -fsSL https://host/install.sh | sh`. It installs the CLI release matching the server's
version (verified against `SHA256SUMS`) and prints `blift login --server <public origin>`.
It downloads through the relay below and falls back to GitHub Releases directly.
Client-side overrides: `BLIFT_VERSION`, `BLIFT_INSTALL_DIR`, `BLIFT_DOWNLOAD_URL` (only this mirror).
With `BLIFT_API_KEY` set (`curl -fsSL https://host/install.sh | BLIFT_API_KEY=bliftk_… sh`) it signs
in right away (`blift login` with the key in its environment) and fails if that does not work.

`GET /api/cli/latest` (no auth) → `{ "version": "0.1.1" }`, the latest published release (from
GitHub, kept for an hour; `502 upstream_error` if GitHub cannot be reached). `blift update` uses it.

`GET /api/cli/download/v<version>/<file>` (no auth) relays a file of the GitHub release `v<version>`:
`blift_<version>_<os>_<arch>.tar.gz` or `SHA256SUMS`; anything else → `404 not_found`. GitHub
unreachable → `502 upstream_error`. Responses are `immutable`; Workers keep them in the edge cache.

## CLI login (device flow)

1. `POST /api/cli/login` (no auth) body `{ "client_name": "blift-cli on my-laptop" }` →
   ```json
   { "device_code": "…", "user_code": "WDJB-MJHT",
     "verification_url": "https://host/cli",
     "verification_url_complete": "https://host/cli?code=WDJB-MJHT",
     "interval": 3, "expires_in": 600 }
   ```
2. CLI opens `verification_url_complete` in a browser (and prints it). The user logs in on the
   web UI and approves.
3. CLI polls `POST /api/cli/login/poll` body `{ "device_code": "…" }` every `interval` seconds:
   - pending → `400 authorization_pending`
   - denied → `400 access_denied`; expired → `400 expired_token`
   - approved → `200 { "token": "blift_…", "user": User }` (one time; the token is a 90-day CLI session)

**With an API key** (no browser): `POST /api/cli/login/api-key` (no auth) body
`{ "api_key": "bliftk_…", "client_name": "blift-cli on build-01" }` → `200 { "token", "user" }`, like
an approved poll. Each call counts one use of the key. Errors: `invalid_api_key` (unknown, expired
or used up), `account_disabled`.

Web-side (authenticated):
- `GET /api/cli/login/:user_code` → `{ user_code, client_name, status, created_at, expires_at }`
- `POST /api/cli/login/:user_code/approve` → 204
- `POST /api/cli/login/:user_code/deny` → 204

## Storages (read-only list for users)

`GET /api/storages` → `{ "storages": [{ "id", "name", "provider", "is_default" }] }`

## Projects

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/projects` | – | `{projects: Project[]}` (all projects the caller is a member of) |
| POST | `/api/projects` | `{name, description?, storage_id?}` | `Project` (201) |
| GET | `/api/projects/:id` | – | `Project` |
| PATCH | `/api/projects/:id` | `{name?, description?, inbox_enabled?}` | `Project` (owner) |
| POST | `/api/projects/:id/inbox/reset` | – | `Project` (owner; new inbox link, 409 `conflict` while disabled) |
| DELETE | `/api/projects/:id` | – | 204 (owner or admin; objects are removed asynchronously by GC) |
| GET | `/api/projects/:id/members` | – | `{members: [{user: UserRef & {email}, role, created_at}]}` |
| POST | `/api/projects/:id/members` | `{user: "<username or email>", role: "editor"\|"viewer"}` | member (owner) |
| PATCH | `/api/projects/:id/members/:userId` | `{role}` | member (owner) |
| DELETE | `/api/projects/:id/members/:userId` | – | 204 (owner, or the member leaving) |
| GET | `/api/users/search?q=` | – | `{users: (UserRef & {email})[]}` (max 10, for member picker) |

Roles: `viewer` = list + download; `editor` = + upload, rename, delete blobs, create shares;
`owner` = + manage members, rename/delete project. Usage is charged to the **owner's** quota.

## Blobs

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/projects/:id/blobs?q=&prefix=&name=&sort=name\|size\|created_at&order=asc\|desc&limit=100&cursor=` | – | `{blobs: Blob[], total?, next_cursor}` (see below) |
| GET | `/api/blobs/:id` | – | `Blob` |
| PATCH | `/api/blobs/:id` | `{name}` | `Blob` (editor) |
| DELETE | `/api/blobs/:id` | – | 204 (editor) |
| POST | `/api/projects/:id/blobs/delete` | `{ids: string[]}` (≤ 100; send more in several requests) | `{deleted: n}` |
| GET | `/api/blobs/:id/download?redirect=1&inline=1` | – | `{url, expires_at}` or `302` to `url` when `redirect=1` |

`url` is a presigned S3 GET (valid 1 h) that sets `Content-Disposition` to the blob name
(`inline` when `inline=1`). Clients download **directly from S3**.

**Listing** (`GET /api/projects/:id/blobs`) is cheap at any project size: every sort is served in
index order and pages continue with a cursor.
- `limit` 1–1000 (default 100). `sort` defaults to `created_at`, `order` to `desc`; names sort
  case-insensitively.
- `next_cursor` is set when more rows follow; pass it back as `cursor` with the same `sort`
  and `order` (another sort → `400 bad_request`). `offset` still works for numbered pages
  (not together with `cursor`) but costs more the deeper it goes.
- `total`, the number of matching blobs, is only returned when `cursor` is absent.
- Filters: `q` (name contains, case-insensitive), `prefix` (name starts with,
  case-insensitive; used for shell completion), `name` (exact name, repeatable, ≤ 50; the
  CLI resolves file arguments with it).

## Uploads (direct to S3 via presigned URLs)

1. **Init** `POST /api/projects/:id/uploads`
   body `{ "name": "a.iso", "size": 123, "content_type": "application/x-iso9660-image", "overwrite": false }`
   ```json
   { "blob_id": "…", "mode": "single", "url": "https://s3…", "expires_at": 0 }
   { "blob_id": "…", "mode": "multipart", "part_size": 16777216, "part_count": 12, "expires_at": 0 }
   ```
   The server picks the mode: `single` when `size <= 64 MiB`, else `multipart`.
   Errors: `name_taken` (when the name exists and `overwrite` is false), `quota_exceeded`.
2. **Transfer**
   - single: `PUT <url>` with the raw body (optionally `Content-Type`).
   - multipart: get part URLs in batches with `POST /api/uploads/:blob_id/parts`
     body `{ "part_numbers": [1,2,3] }` (≤ 100 per call) → `{ "urls": {"1": "https://…"}, "expires_at": 0 }`,
     then `PUT` each part (part *n* covers bytes `[(n-1)*part_size, min(n*part_size, size))`).
     All parts except the last have exactly `part_size` bytes. Uploading parts in parallel is fine.
3. **Complete** `POST /api/uploads/:blob_id/complete` body `{ "parts": [{"part_number": 1, "etag": "\"…\""}] }`
   → `Blob`. `parts` is optional; if omitted the server lists the parts itself (browsers usually
   cannot read the `ETag` header). The server verifies the stored object size.
4. **Abort** `DELETE /api/uploads/:blob_id` → 204.

Unfinished uploads are garbage-collected after `pending_upload_ttl_hours` (default 24).
Presigned URLs are valid for 6 hours.

## Shares

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/shares?project_id=` | – | `{shares: Share[]}` (shares created by me, or in projects I own) |
| POST | `/api/shares` | `{project_id, blob_id?, password?, expires_in?, max_downloads?}` | `Share` (201, editor) |
| DELETE | `/api/shares/:id` | – | 204 (creator, project owner or admin) |

`expires_in` is seconds from now (omit/null = never). `blob_id` omitted = share the whole project.

## Public share access (no login)

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/public/shares/:token?limit=5000&cursor=` | see below |
| POST | `/api/public/shares/:token/unlock` body `{password}` | `{access_token}` + cookie |
| GET | `/api/public/shares/:token/blobs/:blob_id/download?redirect=1` | `{url, expires_at}` or 302 |

```json
{ "share": { "token": "…", "kind": "blob" | "project", "name": "file or project name",
             "has_password": true, "locked": false, "expires_at": null,
             "max_downloads": null, "download_count": 3, "creator": "Alice", "created_at": 0,
             "file_count": 12000, "total_bytes": 123456789 },
  "blobs": [ { "id", "name", "size", "content_type", "created_at" } ],
  "next_cursor": "…" }
```
`blobs` and `next_cursor` are omitted while `locked`. A project share lists its files by name,
`limit` (1–5000, default 5000) at a time; `next_cursor` (else `null`) fetches the next page
as `?cursor=`. `file_count` / `total_bytes` describe the whole share. For password-protected shares pass the access token with
header `X-Share-Access: <token>` or query `?access_token=` (the unlock call also sets an
HttpOnly cookie for browsers). Errors: `not_found`, `share_expired`, `share_exhausted`, `invalid_password`.

## Inbox (anonymous uploads, no login)

An owner can let anyone with a link upload into a project: `PATCH /api/projects/:id`
`{inbox_enabled: true}` (default off). The link is `Project.inbox_url` = `<public origin>/i/<token>`
(the web page); `false` disables it, and enabling again or `POST …/inbox/reset` issues a new token.
Uploaders cannot list, download or replace anything. A name that is taken becomes
`name (1).ext`, `name (2).ext`, … when the upload completes. Usage, quota and traffic stats are
charged to the project owner. Files show up with `uploader: null, via_inbox: true`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/public/inbox/:token` | – | `{inbox: {name, description, owner}}` (`owner` = display name) |
| POST | `/api/public/inbox/:token/uploads` | `{name, size, content_type?}` | upload init + `upload_token` (201) |
| POST | `/api/public/inbox/:token/uploads/:blob_id/parts` | `{part_numbers}` | `{urls, expires_at}` |
| POST | `/api/public/inbox/:token/uploads/:blob_id/complete` | `{parts?}` | `{name, size}` (`name` = final name) |
| DELETE | `/api/public/inbox/:token/uploads/:blob_id` | – | 204 |

The upload flow is the one in **Uploads** (same modes, part sizes and presigned S3 URLs). The
calls after init must send the `upload_token` from the init response as header
`X-Upload-Token: <token>` (valid 6 h, for that upload only). Errors: `not_found` (unknown or
disabled inbox, or a wrong upload token), `quota_exceeded` (owner's quota).

## Admin (role = admin)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/admin/stats?days=30` | – | see below |
| GET | `/api/admin/users?q=&limit=50&offset=0` | – | `{users: AdminUser[], total}` |
| PATCH | `/api/admin/users/:id` | `{role?, status?: "active"\|"disabled", quota_bytes?: number\|null}` | `AdminUser` |
| POST | `/api/admin/users/:id/reset-mfa` | – | 204 |
| DELETE | `/api/admin/users/:id` | – | 204 (their projects are deleted by GC) |
| GET | `/api/admin/projects?q=&limit=50&offset=0` | – | `{projects: (Project & {owner})[], total}` |
| GET | `/api/admin/storages` | – | `{storages: AdminStorage[]}` |
| POST | `/api/admin/storages` | storage config | `AdminStorage` |
| PATCH | `/api/admin/storages/:id` | partial config (`secret_access_key` omitted = unchanged) | `AdminStorage` |
| DELETE | `/api/admin/storages/:id` | – | 204 (409 `conflict` if projects use it) |
| POST | `/api/admin/storages/test` | storage config (+ `id` to reuse the saved secret) | `{ok, latency_ms, error?}` |
| POST | `/api/admin/storages/:id/cors` | `{origins?: string[]}` | `{ok, error?}` (PutBucketCors) |
| GET | `/api/admin/settings` | – | `Settings` |
| PUT | `/api/admin/settings` | partial `Settings` | `Settings` |
| POST | `/api/admin/oidc/test` | `{issuer}` | `{ok, error?, discovery?}` |
| POST | `/api/admin/gc` | – | `{result: {...counters}}` |

```ts
type AdminUser = User & { status: "active" | "disabled"; quota_override: number | null;
                          last_login_at: number | null; project_count: number };
// quota_override: null = use the default quota, -1 = unlimited, n = bytes

type AdminStorage = { id, name, provider: "s3"|"r2"|"b2"|"rustfs"|"minio"|"other",
  endpoint, region, bucket, access_key_id, path_style: boolean, prefix: string,
  is_default: boolean, created_at, project_count: number, used_bytes: number };

type Settings = {
  site: { name: string; default_quota_bytes: number /* -1 unlimited */ };
  oidc: { enabled: boolean; issuer: string; client_id: string; client_secret_set: boolean;
          client_secret?: string /* write-only */; scopes: string; button_label: string;
          admin_group: string; redirect_uri: string /* read-only */ };
  gc: { pending_upload_ttl_hours: number };
};

// GET /api/admin/stats
type Stats = {
  totals: { users, projects, blobs, used_bytes, shares, storages };
  series: { day: "YYYY-MM-DD", requests, upload_bytes, download_bytes, uploads, downloads }[];
  top_users: { id, username, display_name, used_bytes, quota_bytes }[];
  storages: { id, name, used_bytes, blob_count }[];
  // Top 10 users by traffic in the period. id "" (username null) = anonymous requests.
  top_traffic: { id, username: string | null, display_name, requests, upload_bytes, download_bytes }[];
};
```

Traffic counters: `requests` counts API requests; `upload_bytes` is counted when an upload
completes; `download_bytes` when a download URL is issued (the blob size — data itself flows
directly between the client and S3).
