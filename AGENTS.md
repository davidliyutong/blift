# AGENTS.md — notes for agents working in this repository

blift is an internal file-sharing / transfer system backed by S3-compatible object storage. Three
deliverables share one API contract:

| Directory | Contents | Stack |
| --- | --- | --- |
| `server/` | HTTP API (the same code runs on Cloudflare Workers and Node/Docker) | TypeScript, Hono, jose, aws4fetch |
| `web/` | SPA frontend | React 19, Vite, Tailwind v4, `@cloudflare/kumo`, react-router 7 |
| `cli/` | Command-line client | Go, cobra, `CGO_ENABLED=0` single binary |
| `docs/API.md` | **The API contract (single source of truth)** | — |

## Language

The working language is **English**: code, identifiers, comments, docs, commit messages, pull
requests, issues and review comments. The product itself is bilingual:

- UI copy goes through i18n with English and Chinese side by side (see the web and CLI sections).
- User-facing docs have a Chinese translation next to the English main file, named
  `<name>.zh-cn.md`: `README.md` / `README.zh-cn.md` and `cli/README.md` / `cli/README.zh-cn.md`.
  Both start with a language switch line (`English | [简体中文](….zh-cn.md)`). Change both in the
  same commit. `PROMPT.md` (the original brief) is frozen and needs no updates.
- Contributor docs are English only: `AGENTS.md`, `CONTRIBUTING.md`, `RELEASING.md`,
  `docs/API.md`, `CHANGELOG.md`.
- Chinese in tests (file names, i18n output) and the bilingual messages of `install.sh` are
  intentional.

## Common commands

```bash
make install       # pnpm install (workspace: server, web)
make dev           # API :8787 (Node + SQLite, ./data) + Vite :5173 (/api proxied to 8787)
make test          # pnpm -r typecheck + vitest + go test/vet — must pass before committing
make smoke         # end-to-end: starts a RustFS container + a server on a fresh database, runs server/test/smoke.mjs and cli-smoke.sh (needs docker)
make build         # web/dist + server/dist/server.mjs + bin/blift
make dev-worker    # run on the real Workers runtime (local D1) with wrangler dev; needs server/.dev.vars
make deploy        # deploy to Workers; prefers the git-ignored server/wrangler.local.toml (personal deployment config)
```

Run `make smoke` when API behaviour changes; for UI-only changes run at least `pnpm --filter web build`.
`server/wrangler.toml` is the generic template committed to the repository: never put a real D1 ID,
domain or `PUBLIC_URL` in it; those go in `server/wrangler.local.toml` (CI checks this).

CI (`.github/workflows/ci.yml`) runs `make test`, `make build cli-all`, `make smoke` and the Docker
build on pull requests and on main. Releases are triggered by `v*` tags
(`.github/workflows/release.yml`): CLI archives + SHA256SUMS + a multi-arch GHCR image + a GitHub
release. The tag must match `server/src/version.ts` and `CHANGELOG.md`; the steps are in
`RELEASING.md`. Record user-visible changes under `[Unreleased]` in `CHANGELOG.md`.

## Commits, pull requests and issues

The full conventions, with examples, are in [CONTRIBUTING.md](CONTRIBUTING.md). In short:

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
  `<type>(<scope>): <summary>`, with type one of `feat`, `fix`, `perf`, `refactor`, `docs`, `test`,
  `build`, `ci`, `chore`, `revert` (and `release: vX.Y.Z` for releases only). The summary is
  English, imperative ("add", not "added"), starts in lowercase, has no trailing period and is at
  most 72 characters long. The body, wrapped at 72 columns, explains what changed and why; breaking changes
  get `!` after the type and a `BREAKING CHANGE:` footer.
- One logical change per commit; every commit passes `make test`.
- Branches: `<type>/<short-topic>` from `main`, e.g. `feat/api-keys-inbox`.
- Pull request titles use the commit summary format. Descriptions follow
  `.github/pull_request_template.md`: summary, changes, testing (the commands you ran and their
  results), notes (migrations, breaking changes, follow-ups), with `Closes #n` for issues they fix.
- Issues are filed with the forms in `.github/ISSUE_TEMPLATE/`; titles are plain sentences
  describing the problem or the need (no type prefix; labels classify them).

## Changing the API

1. Change `docs/API.md` first.
2. Server: `server/src/routes/*`.
3. Web: `web/src/api/types.ts` (types mirror API.md) and the call sites.
4. CLI: `cli/internal/api/{types,methods}.go`.
5. New error codes need translations in `web/src/i18n/{en,zh}.ts` and `cli/internal/i18n/messages.go`.
6. Add an end-to-end assertion to `server/test/smoke.mjs`.

## Server architecture (`server/src`)

- `app.ts` assembles the Hono app (basePath `/api`); paths outside `/api` that the API handles
  (`/install.sh` and the share links `/s/<token>[/<name>]`) are rewritten onto `/api` routes by
  `ALIASES` and must also be routed to the API in `node.ts` and listed in `run_worker_first` in
  `wrangler.toml`. Browsers opening a share link get the SPA instead (`isSharePage`): both entry
  points hand them over before the API runs, so page loads touch no database. `worker.ts` is the
  Workers entry point (fetch + scheduled GC); `node.ts` is the Docker entry point (node:sqlite,
  static files, GC timer, generated secrets).
- The `DB` interface in `db/index.ts` is a **subset of the D1 API**; `db/node-sqlite.ts` implements
  it on Node. Use only the `one/all/run/stmt` helpers and `db.batch()`; no ORM.
- `db/migrations.ts`: migrations are **append-only, never modified**; they run at startup / on the
  first request. Foreign keys are deliberately not declared (D1 enforces them, and deletion is
  asynchronous); references are cleaned up explicitly in code.
- State machines:
  - blob: `pending` (upload issued) → `active` (size checked with HEAD on complete) → `deleted`
    (GC deletes the object, then the row).
  - project: `active` → `deleting` (all blobs flagged deleted, quota released immediately) → GC
    deletes the row once its blobs are gone.
- Directories (`services/tree.ts`): a directory is a `blobs` row with `kind = 'dir'` (no object in
  storage), and every row names its directory in `parent_id` (`''` = the project's root). Paths
  are **never stored**: they are resolved with one recursive query over at most 16 rows
  (`walkPath`, `chainsOf`), so moving or renaming a directory writes one row. Names are unique
  per directory by the index `blobs_project_name`, files and directories alike. Deleting a
  directory only flags its row, which makes everything below unreachable by path;
  `drainDeletedDirs` then releases the contents level by level, a bounded amount in the request
  and the rest in GC. Queries that mean files must say `kind = 'file'`; S3 work must never see a
  directory row (`storage_id = ''`).
- Quota/usage: `projects.used_bytes/blob_count` and `users.used_bytes` are maintained
  incrementally; GC `reconcile`s them against the real data once a day. Usage counts against the
  **project owner**.
- Permissions: always go through `loadProject(c, id, need)` / `loadBlob(...)` in
  `services/projects.ts`; non-members get 404. Admins implicitly have owner rights on every project.
- Stats: handlers call `addStats(c, {...})`; a middleware writes `stats_daily` with **one** upsert
  after the response (`waitUntil`).
- Errors: throw `ApiError(status, code, message)` (`lib/errors.ts`); `app.onError` renders it as
  `{error:{code,message}}`. The `code` is part of the contract; clients translate by it.
- Security: session tokens are stored only as SHA-256; S3 secrets, OIDC client secrets and TOTP
  secrets are stored encrypted with AES-GCM keyed from `APP_SECRET` and never returned to clients;
  redirects only go to relative in-site paths (`safeRedirect`).

### Cloudflare limits (check each one when writing server code)

- File bytes **never** pass through the server: all uploads and downloads use presigned URLs. The
  only exception is `/api/cli/download`, which relays CLI release files (a few MB, allowlisted,
  `immutable` + edge cache).
- Every S3 call is a subrequest (50 per invocation on the free plan): at most 1–2 in a request
  path; batch work belongs in GC, bounded by `GC_BUDGET`.
- Outbound concurrency ≤ 6: use `pool(items, 6, fn)` from `lib/http.ts`.
- D1 allows ≤ 100 bound parameters per statement: use `chunks()` + `placeholders()` for
  `IN (...)`; use `db.batch()` for consistency across statements.
- Bulk writes (deletes, status changes) touch at most 100 rows per statement: requests only write
  bounded amounts (e.g. bulk delete ≤ 100 items); work of unknown size (deleting a project,
  expiring rows) is only flagged and left to GC, which drains it with `… IN (SELECT … LIMIT 100)`
  within the `GC_ROWS` budget (see `services/gc.ts`).
- Don't add D1 writes to every request: put non-critical writes in `c.executionCtx.waitUntil` and
  merge them where possible.
- CPU: avoid big loops and big JSON; PBKDF2 is already at the Workers maximum of 100,000
  iterations, don't raise it.
- `aws4fetch` retries are set to 1 (the default of 10 would exhaust the subrequest budget).
- Lists never `COUNT(*)` a whole table or use deep `OFFSET`s: build `(project_id, key, id)` partial
  indexes on the sort key and page with keyset cursors (see `listBlobs`); prefer the maintained
  counter columns for counts. D1 bills by rows read, and with bound parameters SQLite cannot know
  how selective an `IN` / prefix condition is, so it may scan a whole sort index to avoid a sort;
  pin the index with `INDEXED BY` where needed and confirm with `EXPLAIN QUERY PLAN` on a database
  with data.

## Web conventions (`web/src`)

- The design language is the Cloudflare dashboard; every component comes from `@cloudflare/kumo`.
  The component API reference is `node_modules/@cloudflare/kumo/ai/component-registry.md` in the
  package (`npx @cloudflare/kumo doc <Component>`).
- Use semantic tokens only (`bg-kumo-base`, `text-kumo-subtle`, `border-kumo-line`…), **no** raw
  Tailwind colors and **no** `dark:` variants (dark mode is handled by `data-mode`). Icons come from
  `@phosphor-icons/react`.
- **All user-visible copy goes through i18n**: add every key to both `src/i18n/en.ts` and `zh.ts`
  (`zh.ts` is typed against `en.ts`) and use it through `useT()`.
- `src/api/` is the typed fetch client; `src/lib/upload.ts` is the upload engine (single PUT /
  parallel multipart + retries; complete sends no parts, the server uses ListParts).
- echarts is lazy-loaded on the admin dashboard only; regular users never download it.

## CLI conventions (`cli/`)

- Places in a project are written `project:path` (`internal/cmd/path.go`); `cp` follows cp/rsync
  (a trailing slash means "the contents of"). Commands that take a project first keep accepting
  the older `<project> <path>...`.
- Entry point `cmd/blift`; commands in `internal/cmd`, the HTTP client in `internal/api`, the
  transfer engine in `internal/transfer`, messages in `internal/i18n` (one English and one Chinese
  map with identical keys).
- Keep dependencies minimal (cobra, x/term). It must cross-compile with `CGO_ENABLED=0` for
  linux/darwin × amd64/arm64 (`make cli-all`).
- Config lives in `$XDG_CONFIG_HOME/blift/config.json` (0600); `BLIFT_SERVER` / `BLIFT_TOKEN` /
  `BLIFT_LANG` override it.

## Product boundaries (don't build these)

- Projects do not nest: project → directories (≤ 16 levels) → files. Names cannot contain `/`;
  paths exist only at the edges (API parameters, CLI arguments), never in the database.
- No billing, elaborate auditing, rate limiting or other "enterprise" features; this is an
  internal tool, keep it light and avoid overly defensive programming.
- No file traffic through the server (including conveniences such as "proxied downloads").
