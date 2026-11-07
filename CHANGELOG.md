# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/davidliyutong/blift/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/davidliyutong/blift/releases/tag/v0.1.0
