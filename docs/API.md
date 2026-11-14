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
| `name_taken` | 409 | a project with that name exists, or a file or directory with that name in the same directory |
| `setup_done` | 409 | bootstrap already completed |
| `share_expired` | 410 | share expired |
| `share_exhausted` | 410 | share reached its download limit, or an upload link its file or size limit |
| `upload_too_large` | 413 | the file is larger than what an upload link can still take |
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
  storage_location: string;              // the backend's location label ("" when not set)
  used_bytes: number; blob_count: number;
  webdav_enabled: boolean;               // see "WebDAV"
  webdav_url: string;                    // <public origin>/dav/<owner>/<project>/
  created_at: number; updated_at: number;
};

type Blob = {                            // a file, or a directory (see "Directories")
  id: string; project_id: string;
  kind: "file" | "dir";
  parent_id: string | null;              // the directory it is in; null = the project's root
  name: string;
  path: string;                          // its path in the project: "docs/2026/a.pdf"
  size: number;                          // 0 for directories
  content_type: string;                  // "application/octet-stream" if unknown, "inode/directory"
  uploader: UserRef | null;
  via_inbox: boolean;                    // uploaded anonymously through an upload link
  download_count: number;
  created_at: number; updated_at: number;
};

type Share = {
  id: string; token: string; url: string;        // url = <public origin>/s/<token>
  mode: "download" | "upload";   // upload = an inbox: anyone with the link can add files (see "Upload links")
  project_id: string; project_name: string;
  blob_id: string | null; blob_name: string | null;  // the shared file or directory; null = whole project
  blob_kind: "file" | "dir" | null; blob_path: string | null;  // … and its kind and path in the project
  download_url: string | null;   // <public origin>/s/<token>/<file name, URL-encoded>; single-file shares
                                 // only: a direct link for wget/curl (see "Share links for wget and curl")
  has_password: boolean;
  expires_at: number | null;
  max_downloads: number | null; download_count: number;   // download links (null / 0 on upload links)
  max_uploads: number | null; max_upload_bytes: number | null;  // upload links: limits on files and on
  upload_count: number; upload_bytes: number;              // their total size; files received so far
  view_count: number;
  creator: UserRef; created_at: number;
};
```

Naming rules:
- Project name: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, unique per owner.
- Blob name (files and directories): 1–255 chars, no `/`, `\`, control chars, not `.`/`..`;
  unique within its directory, case-sensitively, files and directories alike.
- Path: names joined by `/`, relative to the project's root (`docs/2026/a.pdf`; leading and
  trailing slashes are ignored; `""` or `/` is the root). Directories nest at most 16 levels deep.

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
| GET | `/api/auth/sessions` | – | `{sessions: [{id, kind: "web"\|"cli", name, created_at, last_used_at, expires_at, current, api_key_name}]}` (`expires_at` null = until revoked) |
| DELETE | `/api/auth/sessions/:id` | – | 204 |
| GET | `/api/auth/api-keys` | – | `{api_keys: ApiKey[]}` |
| POST | `/api/auth/api-keys` | `{name, max_uses?, expires_in?, session_ttl?}` | `ApiKey & {key}` (201) |
| DELETE | `/api/auth/api-keys/:id?revoke_sessions=1` | – | 204 |
| GET | `/api/auth/dav-passwords` | – | `{dav_passwords: DavPassword[]}` |
| POST | `/api/auth/dav-passwords` | `{name, password?, project_id?, readonly?}` | `DavPassword & {username, password?}` (201) |
| DELETE | `/api/auth/dav-passwords/:id` | – | 204 |

A session whose user has TOTP enabled starts in *pending MFA* state (both local password
login and OIDC login). While pending, every endpoint except `/api/auth/mfa`, `/api/auth/me`
and `/api/auth/logout` returns `401 mfa_required`.

**API keys** let the CLI sign in without a browser (servers, scripts): `blift login --api-key`
or `BLIFT_API_KEY`, and `install.sh` (see below). Each use creates a CLI session that lasts
`session_ttl` (by default 90 days, like a device-flow login, or until revoked); the key is only a
way to obtain one.

```ts
type ApiKey = {
  id: string; name: string;
  prefix: string;                 // first characters of the key, e.g. "bliftk_AbCd"
  max_uses: number | null;        // null = unlimited; 1 = single use
  use_count: number;
  expires_at: number | null;      // the key itself; null = never
  session_ttl: number | null;     // seconds each session it creates lasts; null = until revoked
  last_used_at: number | null; created_at: number;
  session_count: number;          // active CLI sessions created with this key
};
```
Keys look like `bliftk_<32 base62 chars>`. Only their SHA-256 is stored: `key` is returned once, by
the POST. `max_uses` 1–1 000 000 or null, `expires_in` seconds (60 s – 10 years) or null,
`session_ttl` seconds (1 day – 10 years), null for sessions that never expire (they end when they
are signed out, with `revoke_sessions=1`, a password change or when the user is disabled), or
omitted for 90 days. A key
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
an approved poll; the session lasts the key's `session_ttl`. Each call counts one use of the key. Errors: `invalid_api_key` (unknown, expired
or used up), `account_disabled`.

Web-side (authenticated):
- `GET /api/cli/login/:user_code` → `{ user_code, client_name, status, created_at, expires_at }`
- `POST /api/cli/login/:user_code/approve` → 204
- `POST /api/cli/login/:user_code/deny` → 204

## Storages (read-only list for users)

`GET /api/storages` → `{ "storages": [{ "id", "name", "provider", "location", "is_default" }] }`

`location` is a free-text label set by the admin, such as `Singapore` or `US West` (`""` when not
set), shown when users pick the backend of a new project (`storage_id` in `POST /api/projects`).

## Projects

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/projects` | – | `{projects: Project[]}` (all projects the caller is a member of) |
| POST | `/api/projects` | `{name, description?, storage_id?}` | `Project` (201) |
| GET | `/api/projects/:id` | – | `Project` |
| PATCH | `/api/projects/:id` | `{name?, description?, webdav_enabled?}` | `Project` (owner) |
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
| GET | `/api/projects/:id/blobs?parent_id=&path=&q=&prefix=&name=&sort=name\|size\|created_at&order=asc\|desc&limit=100&cursor=` | – | `{dir?, blobs: Blob[], total?, next_cursor}` (see below) |
| GET | `/api/projects/:id/stat?path=` | – | `Blob` at that path (file or directory) |
| POST | `/api/projects/:id/dirs` | `{path, parent_id?, parents?}` | `Blob` (201, or 200 when it existed; editor) |
| GET | `/api/blobs/:id` | – | `Blob` |
| PATCH | `/api/blobs/:id` | `{name?, parent_id?}` | `Blob` (editor): rename and/or move |
| DELETE | `/api/blobs/:id` | – | 204 (editor) |
| POST | `/api/projects/:id/blobs/delete` | `{ids: string[]}` (≤ 100; send more in several requests) | `{deleted: n}` |
| POST | `/api/projects/:id/blobs/move` | `{ids: string[], parent_id}` (≤ 100) | `{moved: n}` |
| GET | `/api/blobs/:id/download?redirect=1&inline=1` | – | `{url, expires_at}` or `302` to `url` when `redirect=1` |

`url` is a presigned S3 GET (valid 1 h) that sets `Content-Disposition` to the blob name
(`inline` when `inline=1`). Clients download **directly from S3**.

### Directories

A project is a tree: a directory is a `Blob` with `kind: "dir"`, and every blob names its directory
in `parent_id`. A directory has no object in storage and does not count in `Project.blob_count`.
Paths are never stored, so renaming or moving a directory is one write however much it holds.

- **Create**: `POST /api/projects/:id/dirs` with `path` relative to the directory `parent_id`
  (default: the root). All but the last name must exist (else `404 not_found`) and the last must
  be free (else `409 name_taken`). With `parents: true` it works like `mkdir -p`: missing
  directories are created and an existing directory is returned (`200`). `name_taken` also when a
  file is in the way; `bad_request` beyond 16 levels.
- **Rename / move**: `PATCH /api/blobs/:id` with `name` and/or `parent_id` (`null` = the root), or
  `POST …/blobs/move` for up to 100 blobs into one directory (all or nothing). Blobs stay in their
  project. `name_taken` when the target directory has that name; `bad_request` when a directory
  would move into itself or below, or deeper than 16 levels; `not_found` for an unknown directory.
- **Delete** (`DELETE /api/blobs/:id`, `…/blobs/delete`): a directory goes with everything below
  it. It disappears at once; its files are released (usage, share links) in the request for a
  small directory and within a GC run or so for a large one. Until then they may still show up in
  the listing of all files.
- **Download**: files only (`400 bad_request` for a directory).

**Listing** (`GET /api/projects/:id/blobs`) has two forms:
- **One directory**: with `parent_id=<directory id>` or `path=<path>` (`path=` or `path=/` is the
  root). Its directories come first, then its files, each in the requested sort. The response has
  `dir: {id, path, parents: [{id, name}]}` (`id: null` and `path: ""` for the root; `parents` from
  the top down, for breadcrumbs), no `total`, and pages with `cursor` only. Unknown directory →
  `404 not_found`.
- **All files** of the project, at every level and without directories: with neither parameter.
  Each blob's `path` tells where it is. This is the form for searching (`q`) and for walking a
  whole project.

Both are cheap at any size: every sort is served in index order and pages continue with a cursor.
- `limit` 1–1000 (default 100). `sort` defaults to `created_at`, `order` to `desc`; names sort
  case-insensitively.
- `next_cursor` is set when more rows follow; pass it back as `cursor` with the same `sort`
  and `order` (another sort → `400 bad_request`). `offset` still works for numbered pages
  (not together with `cursor`) but costs more the deeper it goes.
- `total`, the number of matching files, is only returned by the all-files form when `cursor` is
  absent.
- Filters, on names (not paths), within the directory or over all files: `q` (name contains,
  case-insensitive), `prefix` (name starts with, case-insensitive; used for shell completion),
  `name` (exact name, repeatable, ≤ 50).

## Uploads (direct to S3 via presigned URLs)

1. **Init** `POST /api/projects/:id/uploads`
   body `{ "name": "a.iso", "size": 123, "content_type": "application/x-iso9660-image", "overwrite": false, "parent_id": null }`
   ```json
   { "blob_id": "…", "mode": "single", "url": "https://s3…", "expires_at": 0 }
   { "blob_id": "…", "mode": "multipart", "part_size": 16777216, "part_count": 12, "expires_at": 0 }
   ```
   The server picks the mode: `single` when `size <= 64 MiB`, else `multipart`. `parent_id` is the
   directory the file goes into (omitted or `null` = the root); create it first (`POST …/dirs`).
   Errors: `name_taken` (when the name exists in that directory and `overwrite` is false, or it is
   a directory's), `not_found` (unknown directory), `quota_exceeded`.
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
| POST | `/api/shares` | `{project_id, mode?, blob_id?, password?, expires_in?, max_downloads?, max_uploads?, max_upload_bytes?}` | `Share` (201, editor) |
| DELETE | `/api/shares/:id` | – | 204 (creator, project owner or admin) |

`mode` is `"download"` (default) or `"upload"`. `expires_in` is seconds from now (omit/null =
never). `blob_id` is a file or a directory (with everything below it); omitted = the whole
project. An upload link takes files into a directory or the project's root (`blob_id` of a file
is refused). `max_downloads` applies to download links, `max_uploads` (files) and
`max_upload_bytes` (total size) to upload links; omit/null = no limit.

## Public share access (no login)

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/public/shares/:token?parent_id=&limit=5000&cursor=` | see below |
| POST | `/api/public/shares/:token/unlock` body `{password}` | `{access_token}` + cookie |
| GET | `/api/public/shares/:token/blobs/:blob_id/download?redirect=1` | `{url, expires_at}` or 302 |

```json
{ "share": { "token": "…", "mode": "download", "kind": "blob" | "dir" | "project", "name": "file, directory or project name",
             "has_password": true, "locked": false, "expires_at": null,
             "max_downloads": null, "download_count": 3, "creator": "Alice", "created_at": 0,
             "file_count": 12000, "total_bytes": 123456789 },
  "dir": { "id": null, "path": "", "parents": [] },
  "blobs": [ { "id", "kind", "name", "path", "size", "content_type", "created_at" } ],
  "next_cursor": "…" }
```
An upload link (`"mode": "upload"`, `"kind": "project"` or `"dir"`) describes where the files go
and its limits instead and never lists files: `{share: {token, mode, kind, name, description, has_password,
locked, expires_at, max_uploads, upload_count, max_upload_bytes, upload_bytes, creator,
created_at}}` (`description` is the project's, `""` for a directory). `blobs`, `dir` and
`next_cursor` are omitted while `locked`. A project or directory share is browsed one directory
at a time: `parent_id` is a directory inside the share (default: the shared directory or the
project's root; one outside the share → `404`), listed by name with directories first, `limit`
(1–5000, default 5000) at a time; `next_cursor` (else `null`) fetches the next page as
`?cursor=`. `dir` and each blob's `path` are relative to what is shared, and nothing above it is
revealed. `file_count` / `total_bytes` describe the whole share (`null` for a directory share).
`…/blobs/:blob_id/download` serves any file inside the share. For password-protected shares pass the access token with
header `X-Share-Access: <token>` or query `?access_token=` (the unlock call also sets an
HttpOnly cookie for browsers). Errors: `not_found`, `share_expired`, `share_exhausted`, `invalid_password`.

### Share links for wget and curl

The share link `<public origin>/s/<token>` and the direct link `/s/<token>/<path>` are answered by
the API too: they are aliases of `GET /api/public/shares/:token/direct` and
`GET /api/public/shares/:token/direct/<path>`. `<path>` is the file's name for a single-file share,
else its path below the shared directory or project (`/s/<token>/docs/a.pdf`). File bytes still
never pass through the server.

- **Browsers** get the web page at `/s/<token>` as before: requests whose `Accept` header contains
  `text/html`, and link previews of chat apps (a `User-Agent` containing `bot`, `preview`,
  `crawl`, …, so that previews do not use up downloads).
- **Other clients** (wget, curl and scripts send `Accept: */*`) get the file:
  - `/s/<token>` of a single-file share, or `/s/<token>/<path>` where `path` is the shared file's
    name, or the path of a file in a shared directory or project → `302` to a presigned S3 URL (valid 1 h,
    `Content-Disposition` = the file name). It counts as a download exactly like
    `…/blobs/:blob_id/download` (and is refused once `max_downloads` is reached). Plain
    `wget <url>` names the file after the last segment of the URL it was given, which is why
    `Share.download_url` has the name in it; `curl -OJL` works with either form.
  - `/s/<token>` of a project or directory share → `200 text/plain`, one direct link
    (`<public origin>/s/<token>/<path>`) per line for its first 1000 files (every level, upper
    directories first, by name), e.g. for `wget -i`. Requests with `?access_token=` get it appended to every link.
  - `HEAD` answers `200` with the file's `Content-Length`, `Content-Type` and
    `Content-Disposition`, without counting a download or issuing a URL.
- Upload links have nothing to download: `404` (`not_found`) with a hint to open the link in a
  browser.
- `/s/<token>/<path>` downloads in browsers too; browsers (and link previews) that hit an error
  there are redirected to the share page `/s/<token>`, which shows it (or asks for the password).
- Password-protected shares need an access token from `…/unlock`, as header
  `X-Share-Access: <token>` or query `?access_token=`; without one → `403`.
- Errors are `text/plain` (`<message> (<code>)`) with the API's status and code: `not_found` (404),
  `share_expired` / `share_exhausted` (410), `invalid_password` (403).

## Upload links (anonymous uploads, no login)

A share with `mode: "upload"` is an inbox: anyone with the link (and its password, if set) can
upload into the project (or the directory the link was created for), until the link expires or reaches `max_uploads` files or
`max_upload_bytes` bytes. The link is `Share.url` like any share; browsers get an upload page.
Uploaders cannot list, download, replace anything or create directories. A name that is taken becomes `name (1).ext`,
`name (2).ext`, … when the upload completes. Usage, quota and traffic stats are charged to the
project owner. Files show up with `uploader: null, via_inbox: true`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/api/public/shares/:token/uploads` | `{name, size, content_type?}` | upload init + `upload_token` (201) |
| POST | `/api/public/shares/:token/uploads/:blob_id/parts` | `{part_numbers}` | `{urls, expires_at}` |
| POST | `/api/public/shares/:token/uploads/:blob_id/complete` | `{parts?}` | `{name, size}` (`name` = final name) |
| DELETE | `/api/public/shares/:token/uploads/:blob_id` | – | 204 |

The upload flow is the one in **Uploads** (same modes, part sizes and presigned S3 URLs). Init
needs the share's access token when it has a password (as for downloads: header `X-Share-Access`,
`?access_token=` or the unlock cookie). The calls after init must send the `upload_token` from the
init response as header `X-Upload-Token: <token>` (valid 6 h, for that upload only); an upload
that has started may finish after the link expires. A file counts towards the limits when it
completes. Errors: `not_found` (unknown link, not an upload link, or a wrong upload token),
`invalid_password` (403, locked), `share_expired`, `share_exhausted` (a limit is used up),
`upload_too_large` (the file is larger than the size left), `quota_exceeded` (owner's quota).

## WebDAV

A project whose owner sets `webdav_enabled` is a WebDAV collection at `Project.webdav_url`,
`<public origin>/dav/<owner>/<project>/`; its directories and files follow by path
(`…/dav/alice/papers/zotero/ABCD.zip`). `/dav/` lists the owners and `/dav/<owner>/` the projects
the caller can reach. A project with WebDAV off answers `404`.

**Sign-in** is HTTP Basic with the username and a **WebDAV password**, never the account password
(no second factor is asked for; the user created the password while signed in):

```ts
type DavPassword = {
  id: string; name: string;
  generated: boolean;             // made by the server rather than chosen by the user
  project_id: string | null;      // only this project; null = every project with WebDAV on
  project_name: string | null;
  readonly: boolean;              // cannot change anything
  last_used_at: number | null; created_at: number;
};
```
`POST /api/auth/dav-passwords` without `password` generates one (`bliftd_<24 base62 chars>`) and
returns it in `password`, this once; only its SHA-256 is stored. With `password` (10–128
characters) the user's own is stored hashed and not returned. At most 20 per user. What a
password may do is what the user may do in the project (viewers read), less when it is
`readonly` or limited to a project. Deleting one ends its access at once. Requests without valid
credentials get `401` with `WWW-Authenticate: Basic`; `OPTIONS` needs none.

**Protocol**: RFC 4918 (`DAV: 1, 2`). Locks are granted but **not enforced** (see `LOCK` below).

| Method | Notes |
| --- | --- |
| `OPTIONS` | `200`, `DAV: 1`, `Allow` |
| `PROPFIND` | `Depth: 0` or `1` (`infinity` → `403`); `207` with `displayname`, `resourcetype`, `getcontentlength`, `getcontenttype`, `getetag` (files), `getlastmodified`, `creationdate`, whatever the body asks for. Entries come by name; a directory of any size is streamed. |
| `GET`, `HEAD` | The file, with `ETag`, `Last-Modified`, `Range` support, `If-Match` / `If-None-Match`. `404` when missing. |
| `PUT` | `201` created, `204` replaced, with the new `ETag`. `409` when the parent does not exist, `405` on a directory, `412` for a failed `If-Match` / `If-None-Match: *`, `507` over quota. |
| `DELETE` | `204`; a directory goes with everything in it (see "Directories"). |
| `MKCOL` | `201` (exactly); `405` when the name exists, `409` without the parent. |
| `MOVE`, `COPY` | `Destination` in the same project, `Overwrite: T` (default) or `F`. `201` created, `204` replaced, `412` when the destination exists and `Overwrite` is `F`, `409` without the destination's parent. A move is one write whatever a directory holds; a copy is one storage request per file and takes at most 25 files (`507` beyond). The entity tags of an `If` header are checked. |
| `PROPPATCH` | Accepted (`207`), nothing is stored. |
| `LOCK`, `UNLOCK` | Answered so that Finder, Windows and Office, which only write to a server with locks, can: `LOCK` returns `200` with a lock token (`201` and an empty file when the name was free; a refresh keeps its token), `UNLOCK` `204`. **Nothing is locked**: no request is ever refused for a lock, and when two clients write the same file the last one wins. `If-Match` still guards against replacing a version the client has not seen. |

- A file's `ETag` is its blob id in quotes: every upload makes a new blob, so it is strong and
  changes exactly when the content does. Directories have none; their `getlastmodified` changes
  whenever something directly in them is added, replaced, moved or deleted.
- **File bytes pass through the server here**, unlike everywhere else: a WebDAV client can only
  talk to the URL it was given. Bodies are streamed. On Cloudflare Workers a request body is
  limited to 100 MB (the platform answers `413`); the Node server has no limit below S3's 5 GiB
  for one PUT. A `PUT` without `Content-Length` is accepted up to 16 MiB (`411` beyond).
- Files written over WebDAV are ordinary blobs (`uploader` = the user); usage and stats count as
  for any upload or download.
- Built for, and tested against the request sequences of, Zotero's file sync and OmniFocus
  (OmniDAV's conformance tests).

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
  location: string, is_default: boolean, created_at, project_count: number, used_bytes: number };
// region: the S3 signing region ("auto" for R2, "us-east-1" for MinIO/RustFS…).
// location: optional display label for users (≤ 64 chars, "" = none), e.g. "Singapore".

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
