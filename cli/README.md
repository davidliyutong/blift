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
| `blift ls [project[:path]] [-r] [--sort name\|size\|time] [--query text] [-n 100] [-a]` | Without arguments, your projects. Otherwise that folder, folders first (at most 100 entries; `-n/--limit`, `-a/--all`); `-r` lists every file below with its path; `--query` searches the whole project |
| `blift cp [-r] <source>... <destination> [--overwrite] [-j 4] [-P 4]` | Copy between local paths and `project:path`: uploads and downloads, files and whole trees (see below) |
| `blift mv <project:path>... <project:path>` | Move or rename inside a project, like `mv` (alias `rename`); a folder moves with everything in it, at once |
| `blift rm [-r] <project:path>... [-y]` | Delete files, or folders with `-r` |
| `blift mkdir [-p] <project:path>...` | Create folders (`-p`: with missing parents) |
| `blift tree <project[:path]> [-L depth]` | Show a project or folder as a tree |
| `blift stat <project:path>` / `cat <project:path>` | Details of a file or folder / print a file to stdout |
| `blift url <project:path>` | Print a presigned download URL (valid for 1 hour) |
| `blift upload <project[:dir]> <file>... [-r] [--name N] [--overwrite]` | Upload into a project or folder (aliases `up`, `push`); the same as `cp <file>... project:dir/` |
| `blift download <project[:path]> [path...] [-r] [--all] [-o dir-or-file]` | Download (aliases `dl`, `pull`); `--all` takes the whole project |
| `blift share create <project[:path]> [--password P] [--expires 7d] [--max-downloads N]` | Create a share of a project, a folder or a file; for a file without a password it also prints a direct link for `wget` / `curl` |
| `blift share create <project[:dir]> --upload [--password P] [--expires 7d] [--max-uploads N] [--max-size 10G]` | Create an inbox: anyone with the link can upload into the project (or that folder) but sees nothing in it |
| `blift share put <inbox-url-or-token> <file>... [--password P] [--name N] [-j 4]` | Upload through an inbox link without signing in (a name that is taken gets a number) |
| `blift share ls [project]` / `share rm <share-id>` | List / delete shares (with their type and usage) |
| `blift share get <share-url-or-token> [path...] [--password P] [-o dir]` | Download from a share link without signing in: everything in it, folders included, or just the paths named (a direct link downloads just its file) |
| `blift update [--check] [--version X.Y.Z] [--force]` | Update in place to the latest release (alias `upgrade`) |

### Paths

A place in a project is written `project:path`, as with `scp` and `rclone`: `datasets` or
`datasets:` is the project itself, `datasets:runs/42/model.ckpt` a file, `datasets:runs/` a folder.
The project can be an ID, a name or `owner/name`: an exact ID match wins; among projects with the
same name your own comes first, and if it is still ambiguous the command fails and lists the
candidates. Folders nest up to 16 levels.

`blift cp` tells remote from local by that colon, so a local file with a colon in its name is
written `./a:b`. It follows `cp` and `rsync`:

- The destination is a folder when it exists as one, ends with `/` or there are several sources:
  the sources go into it under their own names, and missing folders are created. Otherwise a single
  source is copied *to that name*.
- Directories need `-r`. A directory keeps its name, unless it is written with a trailing slash,
  which means its contents: `cp -r ./photos demo:album` creates `album` from `photos` when there
  is no `album` yet and `album/photos` when there is; `cp -r ./photos/ demo:album/` always puts
  the files of `photos` straight into `album`.
- `-P` files are transferred at a time (default 4), each with `-j` connections for large files;
  several files share one progress bar.
- Copies stay between this machine and a project. To move things inside a project use `blift mv`,
  which is instant for a folder of any size.

The commands that take a project first also accept the older form `<project> <path>...`
(`blift rm demo a.txt docs/b.txt`), where a path can also be a file ID.

## Updating

`blift update` replaces the running binary with the latest release: it asks the configured blift
server for the latest version and downloads through it, falling back to GitHub (like install.sh;
`BLIFT_DOWNLOAD_URL` sets a mirror). The binary is only replaced after it matches `SHA256SUMS`.
`--check` only checks, `--version` installs a specific version (downgrades too); use
`sudo blift update` when it is installed in a directory that needs root.

## Shell completion

Completes project names, then paths after the colon, a folder at a time (looked up on the server by the prefix typed so far), share
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
blift cp -r ./dist datasets:builds/                 # a whole tree → builds/dist/…, 4 files at a time
blift cp ./notes.md datasets:docs/readme.md         # upload under another name
blift ls datasets:builds/dist --sort size -n 20     # that folder, largest first
blift ls datasets --query ckpt --all                # every file in the project whose name contains "ckpt"
blift tree datasets -L 2
blift mv datasets:builds/dist datasets:releases/v1  # instant, however large
blift dl datasets model.ckpt -o ~/Downloads/        # > 64 MiB: parallel range requests
blift cp -r datasets:releases ./backup              # a folder, with its structure
blift dl datasets --all -o ./backup                 # the whole project
blift rm -r datasets:builds -y
blift share create datasets:releases/v1 --expires 7d
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
- Trees: the folders are created first (one `mkdir -p` request per directory), then the files
  are uploaded into them; downloads walk the folder a listing at a time. Empty folders are kept
  both ways; symlinks to files are followed, other special files skipped.
- When some of several files fail, the rest are still processed and the command exits non-zero.
- Progress bars only appear when stderr is a terminal and `-q` is not set; status messages go to
  stderr, tables / JSON to stdout.
