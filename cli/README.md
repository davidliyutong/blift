# blift CLI

English | [简体中文](README.zh-cn.md)

The blift command-line client (Go, a single static binary for Linux/macOS × amd64/arm64).
Files never pass through the server: uploads and downloads go straight to the object storage
through S3 presigned URLs issued by the server.

## Install

```sh
curl -fsSL https://<your blift server>/install.sh | sh
```

This installs the CLI version that matches the server: downloaded from the GitHub release through
the server (directly from GitHub if that fails) and SHA-256 verified. Optional environment variables:
`BLIFT_INSTALL_DIR` (install directory, default `~/.local/bin`), `BLIFT_VERSION` (a specific version),
`BLIFT_DOWNLOAD_URL` (download only from this mirror) and `BLIFT_API_KEY` (sign in with this API key
after installing, for unattended setup: `curl -fsSL https://<server>/install.sh | BLIFT_API_KEY=bliftk_… sh`).

## Build and test

```sh
cd cli
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=v0.1.0" -o ../bin/blift ./cmd/blift
go test ./... && go vet ./...
```

## Configuration

- Config file: `$XDG_CONFIG_HOME/blift/config.json` (default `~/.config/blift/config.json`, mode 0600),
  holding `server`, `token` and `user`.
- Environment: `BLIFT_SERVER`, `BLIFT_TOKEN`, `BLIFT_LANG` (`zh` / `en`); `BLIFT_API_KEY` is only read
  by `blift login`.
- Global flags: `--server URL`, `--lang zh|en`, `--json` (raw JSON output), `-q/--quiet`.
- Language: `--lang` > `BLIFT_LANG` > `LC_ALL` / `LC_MESSAGES` / `LANG` (Chinese if it starts with
  `zh`) > English.
- A saved token is only ever sent to the server that issued it; `BLIFT_TOKEN` always wins.

## Commands

| Command | Description |
| --- | --- |
| `blift login [--server URL] [--no-browser] [--token T \| --api-key K]` | Sign in by approving a device code in the browser; or exchange an API key (created in the web UI under Account → API keys, `BLIFT_API_KEY` by default) for a session; or use a token directly |
| `blift logout` / `whoami` / `version` | Sign out, show the current user, show the version |
| `blift project ls\|create\|info\|rm\|rename\|members\|add-member\|rm-member` | Manage projects (aliases `projects`, `p`) |
| `blift ls <project> [--sort name\|size\|time] [--query text] [-n 100] [-a]` | List files (at most 100 by default; `-n/--limit` changes that, `-a/--all` lists all) |
| `blift upload <project> <file>... [--name N] [--overwrite] [-j 4]` | Upload (aliases `up`, `push`) |
| `blift download <project> [file...] [--all] [-o dir-or-file] [-j 4]` | Download (aliases `dl`, `pull`) |
| `blift rm <project> <file>... [-y]` | Delete files |
| `blift mv <project> <file> <new-name>` | Rename a file |
| `blift url <project> <file>` | Print a presigned download URL (valid for 1 hour) |
| `blift share create <project> [file] [--password P] [--expires 7d] [--max-downloads N]` | Create a share (the whole project when no file is given); for a file without a password it also prints a direct link for `wget` / `curl` |
| `blift share ls [project]` / `share rm <share-id>` | List / delete shares |
| `blift share get <share-url-or-token> [file...] [--password P] [-o dir]` | Download from a share link without signing in (a direct link downloads just its file) |
| `blift update [--check] [--version X.Y.Z] [--force]` | Update in place to the latest release (alias `upgrade`) |

A project argument can be an ID, a name or `owner/name`: an exact ID match wins; among projects
with the same name your own comes first, and if it is still ambiguous the command fails and lists
the candidates. A file argument can be a file name or an ID (looked up by exact name: one request,
however large the project).

## Updating

`blift update` replaces the running binary with the latest release: it asks the configured blift
server for the latest version and downloads through it, falling back to GitHub (like install.sh;
`BLIFT_DOWNLOAD_URL` sets a mirror). The binary is only replaced after it matches `SHA256SUMS`.
`--check` only checks, `--version` installs a specific version (downgrades too); use
`sudo blift update` when it is installed in a directory that needs root.

## Shell completion

Completes project names, file names (looked up on the server by the prefix typed so far), share
IDs, members and users, and the values of flags such as `--sort`, `--role`, `--storage`,
`--expires` and `--lang`:

```sh
# zsh (make sure that directory in fpath comes before compinit)
blift completion zsh > "${fpath[1]}/_blift"
# bash (needs bash-completion)
blift completion bash > ~/.local/share/bash-completion/completions/blift
# fish
blift completion fish > ~/.config/fish/completions/blift.fish
```

## Examples

```sh
blift login --server https://files.example.com     # approve in the browser
blift p create datasets -d "training data"
blift up datasets ./model.ckpt ./notes.md -j 8      # > 64 MiB: multipart, parts in parallel
blift up datasets ./dist                            # a directory: its regular files only (not recursive)
blift ls datasets --sort size -n 20                 # the 20 largest files
blift ls datasets --query ckpt --all                # every file whose name contains "ckpt"
blift dl datasets model.ckpt -o ~/Downloads/        # > 64 MiB: parallel range requests
blift dl datasets --all -o ./backup
blift share create datasets model.ckpt --password 1234 --expires 7d
blift share get https://files.example.com/s/AbCd123 --password 1234 -o .
wget https://files.example.com/s/XyZ7890/notes.md   # no blift needed: a direct link (shares without a password)
blift --json ls datasets | jq '.[].name'
```

## Behaviour

- Upload: `init` first; the server picks a single PUT (≤ 64 MiB) or multipart. Part URLs come in
  batches of at most 100 and are uploaded `-j` at a time, each part retried 3 times (exponential
  backoff), then `complete` with the list of ETags. On failure or Ctrl-C the upload is cancelled
  with `DELETE /api/uploads/:id`.
- Download: written to `<target>.part` first and renamed when complete; the temporary file is
  removed on failure.
- When some of several files fail, the rest are still processed and the command exits non-zero.
- Progress bars only appear when stderr is a terminal and `-q` is not set; status messages go to
  stderr, tables / JSON to stdout.
