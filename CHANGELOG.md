# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Folders in the web UI: browse a project folder by folder (breadcrumbs, folders first), create
  folders, upload a folder (picker or drag and drop; its structure is kept), move files and
  folders, share a folder as a download link or an inbox, and browse shared folders on the share
  page. Search still covers the whole project and shows where each file is.
- **WebDAV.** A project's owner can turn WebDAV on in its settings; the project is then at
  `/dav/<owner>/<project>/` for Zotero, OmniFocus, file managers and other WebDAV clients. They
  sign in with the username and a WebDAV password from Account → WebDAV passwords (generated or
  your own, optionally limited to one project or to reading), never the account password.
  Supports PROPFIND, GET with ranges, PUT, DELETE, MKCOL, MOVE and COPY (class 1, no locking).
  Files uploaded this way pass through the server: on Cloudflare Workers they are limited to
  100 MB each. Deployments on Workers need `/dav` and `/dav/*` in `run_worker_first` (see
  `server/wrangler.toml`; `make cf-config` writes it).
- Folders in the CLI. Places are written `project:path` (`demo:docs/a.pdf`), as with scp and
  rclone. New commands: `blift cp` (uploads and downloads, `-r` for whole trees, `-P` files at
  a time), `mkdir [-p]`, `tree`, `stat` and `cat`. `ls` lists a folder (`-r` for everything
  below, no arguments for your projects), `mv` moves as well as renames, `rm -r` deletes
  folders, `share create demo:docs` shares a folder and `share get` downloads one with its
  structure. Shell completion follows paths a folder at a time. The older `<project> <name>`
  forms keep working.
- **Directories** (server and API). A project is now a tree, up to
  16 levels deep: `POST /api/projects/:id/dirs` (like `mkdir`, or `mkdir -p` with `parents`),
  uploads take a `parent_id`, `GET …/blobs?path=` / `?parent_id=` lists one directory
  (directories first) and `GET …/stat?path=` resolves a path. `PATCH /api/blobs/:id` moves as
  well as renames, `POST …/blobs/move` moves up to 100 at once, and deleting a directory deletes
  everything below it. Renaming or moving a directory is instant however much it holds. Every
  `Blob` has `kind`, `parent_id` and `path`; without `path` / `parent_id` the listing still
  returns all files of the project.
- Share links for a directory: a download link is browsed a directory at a time and serves
  `/s/<token>/<path>` to wget and curl; an inbox link can take files into a directory. Project
  shares show directories too.
- `make cf-config` writes `server/wrangler.local.toml` from the template and the environment
  (`CF_D1_ID`, `CF_DOMAIN`, `PUBLIC_URL`), so Cloudflare Workers Builds can deploy from GitHub.
- `blift share put <inbox link> <file>...` uploads through an inbox link without signing in
  (`--password` for a protected link, `--name`, `-j`); it stops once the link is used up.

### Changed

- `blift upload <project> <dir>` no longer uploads the files directly inside a directory: it asks
  for `-r` and then uploads the whole tree. `blift ls <project>` lists the project's top folder
  rather than every file (`-r` does that), and several files are transferred at a time, sharing
  one progress bar.

- **Breaking:** the project inbox is now a kind of share link. "Create share link" offers Download
  or Inbox; an inbox link (`/s/<token>`) can have a password, an expiry and limits on the number of
  files and their total size, and it is listed, copied and deleted like any share. Editors can
  create one. Project settings no longer have an inbox switch, existing inbox links (`/i/<token>`)
  stop working, and the API drops `Project.inbox_enabled` / `inbox_url`,
  `POST /api/projects/:id/inbox/reset` and `/api/public/inbox/*` (uploads go to
  `/api/public/shares/:token/uploads`). `blift share create --upload [--max-uploads N]
  [--max-size 10G]` creates one, and `blift share ls` shows each link's type and usage.

### Fixed

- Signing in with 1Password filling in the two-factor code sent the user back to the empty sign-in
  page: its auto-submit clicked "Sign in with a different account", which signed the session out.
  That link is now outside the code form and renamed "Use a different account", and the code
  form submits itself once six digits are entered.
- The breadcrumb link back to the project list ("Projects") reloaded the current page instead.

## [0.2.0] - 2026-11-11

### Added

- API keys for unattended CLI setup: create them under Account → API keys (single use or a number
  of uses, optional expiry), then `curl -fsSL https://host/install.sh | BLIFT_API_KEY=bliftk_… sh`
  installs and signs in, or `blift login --api-key` / `BLIFT_API_KEY`. Each use creates a CLI
  session linked to the key, valid for the key's sign-in lifetime (7 to 365 days, 90 by default,
  or until revoked); deleting a key can sign those sessions out too.
- Project inbox: owners can let anyone with a link (`/i/<token>`) upload into a project without an
  account (off by default; the link can be reset). Uploaders see nothing in the project, a taken
  name gets a number instead of replacing a file, and usage counts against the owner's quota.
  Inbox uploads are labelled in the file list.
- Storage backends have an optional location label ("Singapore", "US West"). The new-project
  dialog always shows the backend picker, with each backend's location, and the project settings
  and `blift project info` show it too; `blift project create --storage` completes backends with
  their location. The signing-region field in the admin form is now called "S3 region".
- Direct share links for scripts: `/s/<token>/<file name>` (`download_url` on shares, shown in the
  share dialog, the share list and by `blift share create`) downloads the file, so plain
  `wget <link>` saves it under its own name. On a project share's link, wget and curl get a
  plain-text list of these links (`wget -i`). `blift share get` accepts direct links.

### Fixed

- `wget` / `curl` on a share link (`/s/<token>`) saved the web page instead of the file. Clients
  that do not ask for HTML now get a redirect to the file (counted as a download, within the
  share's limits); browsers and chat link previews still get the page. Password-protected shares
  answer 403 unless given an access token. **Cloudflare Workers:** add `"/s/*"` to
  `run_worker_first` in your `server/wrangler.local.toml` before deploying.
- `/install.sh` answered 500 on Node 26.

## [0.1.2] - 2026-11-07

### Added

- CLI shell completion for projects, file names (prefix lookup on the server), shares, members,
  users and flag values: `blift completion zsh|bash|fish`.
- `blift update` replaces the CLI with the latest release (or `--version`), looked up and
  downloaded through the blift server (`GET /api/cli/latest` and the download relay) with GitHub
  as the fallback, SHA-256 verified; `--check` only reports.
- `blift ls` lists at most 100 files by default and says how many there are; `-n/--limit`,
  `-a/--all` and `--query` widen or filter it.
- File listing API: cursor paging (`next_cursor`), `prefix` and exact `name` filters. Public
  project shares are paged too (`next_cursor`, `file_count`, `total_bytes`); the share page loads
  more files on demand.

### Fixed

- Large projects: listings are read in index order (new indexes), so a page no longer sorts and
  counts every file of the project; the CLI resolves file names with an exact lookup instead of
  listing the whole project; public project shares are no longer cut off at 5,000 files.
- Mass deletes: deleting a project (or a user's projects) is constant work; GC releases its files,
  shares and members afterwards. Every GC write touches at most 100 rows, each run writes at most
  `GC_ROWS` rows, and the work is shared fairly so one backlog cannot starve the rest. A storage
  that cannot be reached is skipped instead of blocking the queue. Bulk delete takes ≤ 100 ids per
  request (the CLI and web UI send larger sets in batches).
- The admin dashboard no longer counts every file on each load.

### Changed

- `blift ls` (also with `--json`) returns 100 files unless `-n/--limit` or `-a/--all` says
  otherwise; scripts that need every file should add `--all`.
- `POST /api/projects/:id/blobs/delete` accepts at most 100 ids per request (was 500).
- New flowing **b** logo with a lifted wing, shared by the web UI, favicon and READMEs.
  The navigation logo gently lifts on hover or keyboard focus and respects reduced-motion preferences.

## [0.1.1] - 2026-11-07

### Added

- CLI installer served by every blift server: `curl -fsSL https://<server>/install.sh | sh`
  installs the CLI release matching the server version into `~/.local/bin` (SHA-256 verified,
  no sudo) and prints the `blift login` command for that server. Account settings show the command.
- `GET /api/cli/download/…` relays the CLI release files from GitHub Releases (edge-cached on
  Workers), so clients without GitHub access can install the CLI; the installer uses it first.

## [0.1.0] - 2026-11-07

First release.

### Added

- Server (TypeScript + Hono) running on Cloudflare Workers (D1, Workers Assets, Cron) and on
  Node/Docker (`node:sqlite`) from the same code; migrations apply automatically.
- Projects with flat file lists, members (owner / editor / viewer) and per-user quotas.
- Direct uploads and downloads with presigned URLs: single `PUT` up to 64 MiB, parallel multipart
  above that, size verified with `HEAD` before it counts against the quota.
- Storage backends: any S3-compatible service (Cloudflare R2, Backblaze B2, AWS S3, RustFS,
  MinIO), several at once, chosen per project; connection test and `Apply CORS` in the admin UI.
- Share links for a file or a whole project, with optional password, expiry and download limit.
- Sign-in with OIDC (authorization code + PKCE, HS256 / RS256 / ES256 ID tokens, tuned for
  Authentik): users are created on first sign-in, an IdP group can grant the admin role.
- Local admin accounts created with a one-off bootstrap secret; TOTP two-factor authentication.
- Admin dashboard (usage, requests, traffic, uploads and downloads), user management with quota
  and role changes, online settings for storage, SSO and the default quota.
- Web UI in Cloudflare's Kumo design system, English and Chinese, light and dark themes; reloads
  itself after a deploy replaced its code; credential forms work with password managers.
- Go CLI with browser login (device flow), project and member management, parallel uploads and
  ranged downloads, share links and account-free share downloads; static binaries for Linux and
  macOS on amd64 and arm64.
- Garbage collection of stale uploads, deleted files and projects, expired sessions and shares,
  within Cloudflare's subrequest limits; daily reconciliation of usage counters.
- Docker image for linux/amd64 and linux/arm64 on GHCR, CI with an end-to-end suite against
  RustFS, and a tag-driven release pipeline.

[Unreleased]: https://github.com/davidliyutong/blift/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/davidliyutong/blift/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/davidliyutong/blift/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/davidliyutong/blift/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/davidliyutong/blift/releases/tag/v0.1.0
