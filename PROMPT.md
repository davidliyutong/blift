# Original brief

English | [简体中文](PROMPT.zh-cn.md)

The brief blift was built from, translated from the original Chinese. It is kept for reference;
[README.md](README.md) and [AGENTS.md](AGENTS.md) describe the project as it is now.

---

Build file-sharing / transfer software backed by object storage.

## Business logic

- Lightweight: no tree structure, only two levels, project / blob
- Public sharing: generate share links, with optional password protection

## Technology

- Works with S3 object storage such as Backblaze B2, Cloudflare R2, AWS S3 and RustFS
- Uploads and downloads go directly to S3 (presigned S3 URLs)
- Runs natively on Cloudflare Workers, optionally in Docker
- OIDC sign-in, Authentik first

## Clients

Build a web frontend and a CLI together; Go is suggested for the CLI.

- The CLI can also sign in through OIDC in the browser (like the gh tool)
- The CLI can manage projects, upload and download
- Clients for several platforms (Linux/Mac, amd64/arm64), ideally a single binary
- Interaction through the web UI

## User experience

- When deploying, the admin provides a one-off secret and registers themselves with it
- Admins can configure storage backends and connect OIDC
- Admins get a dashboard of how the system is used (storage used, request counts, data transferred)
- Admins can manage users and adjust their storage quotas
- New OIDC users are registered automatically on first sign-in; HS256 and RS256 are supported

## Reference implementations

- ZPan https://github.com/saltbo/zpan (for its UI library)
- Safebucket https://github.com/safebucket/safebucket
- Plik https://github.com/root-gg/plik

## Other notes

- Main targets managed with a Makefile
- Design a suitable AGENTS.md to help other agents work on the project
- Multilingual support (Chinese / English)
- Do not encourage overly defensive programming
- Mind Cloudflare's concurrency limits
- Admins need two-factor authentication
- For internal use: no over-engineering (e.g. billing)
- Pay attention to garbage collection and error handling
