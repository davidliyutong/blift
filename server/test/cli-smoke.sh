#!/usr/bin/env bash
# CLI end-to-end test against a running, *fresh* server (performs the bootstrap itself).
# Env: BASE, BOOTSTRAP_SECRET, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, BLIFT (binary)
set -euo pipefail

: "${BASE:?}" "${BOOTSTRAP_SECRET:?}" "${S3_ENDPOINT:?}" "${S3_BUCKET:?}" "${S3_ACCESS_KEY:?}" "${S3_SECRET_KEY:?}" "${BLIFT:?}"
WORK=$(mktemp -d)
trap '/bin/rm -rf "$WORK"' EXIT
export XDG_CONFIG_HOME="$WORK/config" BLIFT_LANG=en
JAR="$WORK/cookies"
ok() { echo "✓ $*"; }
fail() { echo "✗ $*" >&2; exit 1; }
j() { curl -sf -b "$JAR" -c "$JAR" -H 'content-type: application/json' "$@"; }

# Admin bootstrap + storage through the API (the web UI does the same).
j -X POST "$BASE/api/setup" -d "{\"secret\":\"$BOOTSTRAP_SECRET\",\"username\":\"admin\",\"password\":\"password123\"}" >/dev/null
j -X POST "$BASE/api/admin/storages" -d "{\"name\":\"local\",\"provider\":\"rustfs\",\"endpoint\":\"$S3_ENDPOINT\",\"region\":\"us-east-1\",\"bucket\":\"$S3_BUCKET\",\"access_key_id\":\"$S3_ACCESS_KEY\",\"secret_access_key\":\"$S3_SECRET_KEY\",\"prefix\":\"cli\",\"location\":\"Singapore\"}" >/dev/null
ok "bootstrap + storage"

# Device login: run the CLI, approve the printed code with the admin's browser session.
"$BLIFT" login --server "$BASE" --no-browser >"$WORK/login.out" 2>&1 &
LOGIN_PID=$!
for _ in $(seq 1 50); do CODE=$(grep -oE '[A-Z]{4}-[A-Z]{4}' "$WORK/login.out" | head -1 || true); [ -n "$CODE" ] && break; sleep 0.2; done
[ -n "${CODE:-}" ] || fail "no user code printed: $(cat "$WORK/login.out")"
j -X POST "$BASE/api/cli/login/$CODE/approve" >/dev/null
wait $LOGIN_PID || fail "login failed: $(cat "$WORK/login.out")"
"$BLIFT" whoami | grep -q admin || fail "whoami"
ok "blift login (device flow, code $CODE)"

# Unattended login with a single-use API key, each in a fresh config.
KEY=$(j -X POST "$BASE/api/auth/api-keys" -d '{"name":"cli-smoke","max_uses":1}' | grep -oE 'bliftk_[0-9A-Za-z]{32}')
[ -n "$KEY" ] || fail "create API key"
XDG_CONFIG_HOME="$WORK/config-key" BLIFT_API_KEY="$KEY" "$BLIFT" login --server "$BASE" >/dev/null 2>&1 || fail "login with BLIFT_API_KEY"
XDG_CONFIG_HOME="$WORK/config-key" "$BLIFT" whoami | grep -q admin || fail "whoami after API key login"
XDG_CONFIG_HOME="$WORK/config-key2" "$BLIFT" login --server "$BASE" --api-key "$KEY" 2>"$WORK/key.err" && fail "single-use key accepted twice"
grep -q "invalid, expired or used up" "$WORK/key.err" || fail "used-up key message: $(cat "$WORK/key.err")"
ok "blift login with BLIFT_API_KEY / --api-key (single use)"

"$BLIFT" project create demo -d "cli smoke" >/dev/null
"$BLIFT" project ls | grep -q demo || fail "project ls"
"$BLIFT" project info demo | grep -q "local · Singapore" || fail "project info storage location"
ok "project create / ls / info"

mkdir -p "$WORK/up" "$WORK/down" "$WORK/shared"
printf 'hello from the cli\n' >"$WORK/up/hello.txt"
head -c $((100 * 1024 * 1024 + 7)) /dev/urandom >"$WORK/up/big.bin"
"$BLIFT" -q upload demo "$WORK/up/hello.txt" "$WORK/up/big.bin" -j 4
"$BLIFT" upload demo "$WORK/up/hello.txt" 2>/dev/null && fail "duplicate upload should fail without --overwrite"
"$BLIFT" -q upload demo "$WORK/up/hello.txt" --overwrite
[ "$("$BLIFT" --json ls demo | grep -o '"name"' | wc -l | tr -d ' ')" = 2 ] || fail "ls count"
ok "upload single + multipart (100 MiB), --overwrite"

"$BLIFT" -q download demo --all -o "$WORK/down" -j 4
cmp "$WORK/up/big.bin" "$WORK/down/big.bin" || fail "big.bin differs"
cmp "$WORK/up/hello.txt" "$WORK/down/hello.txt" || fail "hello.txt differs"
curl -sf "$("$BLIFT" url demo hello.txt)" | grep -q "hello from the cli" || fail "blift url"
ok "download --all (parallel ranges) + url, contents identical"

"$BLIFT" mv demo hello.txt greeting.txt
"$BLIFT" ls demo | grep -q greeting.txt || fail "mv"

# Shell completion (cobra's hidden __complete command prints "candidate<TAB>description" lines).
comp() { "$BLIFT" __complete "$@" 2>/dev/null | grep -v '^:'; }
comp ls "" | grep -q '^demo	' || fail "complete projects: $(comp ls "")"
[ "$(comp download demo gr | cut -f1)" = greeting.txt ] || fail "complete files by prefix: $(comp download demo gr)"
comp rm demo big.bin "" | grep -q '^big.bin' && fail "complete repeats a file already given"
comp rm demo big.bin "" | grep -q '^greeting.txt' || fail "complete other files"
[ "$(comp ls demo --sort "" | cut -f1 | tr '\n' ' ')" = "name size time " ] || fail "complete --sort"
[ "$(comp project create x --storage "")" = "local	Singapore (rustfs)" ] || fail "complete --storage: $(comp project create x --storage "")"
ok "shell completion: projects, files by prefix, flags, storages"

"$BLIFT" ls demo --limit 1 2>"$WORK/ls.err" | grep -c 'greeting.txt\|big.bin' | grep -qx 1 || fail "ls --limit"
grep -q "showing the first 1 entries" "$WORK/ls.err" || fail "ls --limit hint: $(cat "$WORK/ls.err")"
[ "$("$BLIFT" --json ls demo --all | grep -o '"name"' | wc -l | tr -d ' ')" = 2 ] || fail "ls --all"
[ "$("$BLIFT" ls demo --query greet | grep -c greeting.txt)" = 1 ] || fail "ls --query"
ID=$("$BLIFT" --json ls demo --query greet | grep -oE '"id": *"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
curl -sf "$("$BLIFT" url demo "$ID")" | grep -q "hello from the cli" || fail "resolve a file by id"
ok "ls --limit / --all / --query, files by name or id"
URL=$("$BLIFT" --json share create demo --password pw1234 --expires 1d | grep -oE '"url": *"[^"]+"' | sed -E 's/.*"(http[^"]+)"/\1/')
[ -n "$URL" ] || fail "share create"
"$BLIFT" share get "$URL" --password wrong -o "$WORK/shared" 2>/dev/null && fail "wrong password accepted"
"$BLIFT" -q share get "$URL" --password pw1234 -o "$WORK/shared"
cmp "$WORK/up/big.bin" "$WORK/shared/big.bin" || fail "shared big.bin differs"
"$BLIFT" share ls demo | grep -q pw1234 && fail "password leaked in share ls"
ok "share create (password) + anonymous share get"

# Inboxes (upload links): created like any share, listed with their limits, nothing to download.
INBOX=$("$BLIFT" share create demo --upload --max-uploads 3 --max-size 10M 2>/dev/null) || fail "share create --upload"
"$BLIFT" share ls demo | grep -F "$INBOX" | grep -q "0/3 · 0 B/10.0 MiB" || fail "inbox in share ls: $("$BLIFT" share ls demo)"
"$BLIFT" share get "$INBOX" -o "$WORK/inbox" 2>/dev/null && fail "share get on an inbox"
"$BLIFT" share create demo greeting.txt --upload 2>/dev/null && fail "--upload with a file"
ok "share create --upload (inbox), share ls usage, share get refuses it"

# Uploading through an inbox needs no login: a taken name gets a number, the limits hold.
printf 'dropped off\n' >"$WORK/note.txt"
"$BLIFT" share put "$INBOX" "$WORK/note.txt" "$WORK/note.txt" 2>"$WORK/put.err" || fail "share put: $(cat "$WORK/put.err")"
grep -q 'note (1).txt' "$WORK/put.err" || fail "share put rename: $(cat "$WORK/put.err")"
"$BLIFT" download demo "note (1).txt" -o "$WORK/note-back.txt" -q && cmp "$WORK/note.txt" "$WORK/note-back.txt" || fail "inbox file content"
"$BLIFT" share put "$INBOX" "$WORK/note.txt" "$WORK/note.txt" "$WORK/note.txt" 2>"$WORK/put.err" && fail "share put past the file limit"
grep -q 'reached its limit' "$WORK/put.err" && grep -q '2 of 3 file(s) failed' "$WORK/put.err" || fail "share put limit: $(cat "$WORK/put.err")"
"$BLIFT" share ls demo | grep -F "$INBOX" | grep -q "3/3" || fail "inbox usage after share put"
PINBOX=$("$BLIFT" share create demo --upload --password pw5678 2>/dev/null) || fail "share create --upload --password"
"$BLIFT" share put "$PINBOX" "$WORK/note.txt" </dev/null 2>/dev/null && fail "share put without the password"
"$BLIFT" -q share put "$PINBOX" "$WORK/note.txt" --password pw5678 || fail "share put with the password"
"$BLIFT" share put "$URL" "$WORK/note.txt" --password pw1234 2>/dev/null && fail "share put on a download link"
ok "share put: anonymous, auto-rename, file limit, password, refuses download links"

# Direct links: plain curl and wget save the file under its own name; share get takes them too.
"$BLIFT" share create demo greeting.txt >"$WORK/share.out" 2>"$WORK/share.err"
DIRECT=$(grep -oE 'https?://[^ ]+/s/[0-9A-Za-z]+/greeting\.txt' "$WORK/share.err")
[ -n "$DIRECT" ] || fail "share create prints no direct link: $(cat "$WORK/share.err")"
SHARE=$(cat "$WORK/share.out")
mkdir -p "$WORK/d1" "$WORK/d2" "$WORK/d3" "$WORK/d4"
(cd "$WORK/d1" && curl -sfOJL "$SHARE") || fail "curl -OJL share link"
(cd "$WORK/d2" && curl -sfOL "$DIRECT") || fail "curl -OL direct link"
"$BLIFT" -q share get "$DIRECT" -o "$WORK/d3"
for d in d1 d2 d3; do cmp "$WORK/up/hello.txt" "$WORK/$d/greeting.txt" || fail "direct download into $d"; done
if command -v wget >/dev/null; then
  (cd "$WORK/d4" && wget -q "$DIRECT") || fail "wget direct link"
  cmp "$WORK/up/hello.txt" "$WORK/d4/greeting.txt" || fail "wget saved: $(ls "$WORK/d4")"
fi
curl -sf "$URL" >/dev/null && fail "password share downloaded without a password"
ok "direct links: curl -OJL, curl -O, wget, share get"

# Folders: project:path, cp / mv / mkdir / tree / stat / cat, recursive transfers both ways.
mkdir -p "$WORK/tree/photos/2026" "$WORK/tree/empty"
printf 'one\n' >"$WORK/tree/a.txt"; printf 'two\n' >"$WORK/tree/photos/b.txt"; printf 'three\n' >"$WORK/tree/photos/2026/c.txt"
"$BLIFT" mkdir demo:docs/2026 2>/dev/null && fail "mkdir created parents without -p"
"$BLIFT" -q mkdir -p demo:docs/2026
"$BLIFT" -q mkdir -p demo:docs/2026 || fail "mkdir -p on an existing folder"
"$BLIFT" -q cp "$WORK/tree/a.txt" demo:docs/2026/            # into a folder
"$BLIFT" -q cp "$WORK/tree/a.txt" demo:docs/renamed.txt      # under another name
"$BLIFT" -q upload demo:docs "$WORK/tree/photos/b.txt"       # the older command takes a folder too
"$BLIFT" cp "$WORK/tree" demo: 2>/dev/null && fail "cp of a directory without -r"
"$BLIFT" -q cp -r "$WORK/tree" demo:backup                   # the tree becomes backup
"$BLIFT" -q cp -r "$WORK/tree" demo:backup/                  # …and goes into it as backup/tree
"$BLIFT" cp "$WORK/tree/a.txt" demo:docs/2026/ 2>"$WORK/cp.err" && fail "cp replaced a file without --overwrite"
grep -q -- "--overwrite" "$WORK/cp.err" || fail "cp name_taken hint: $(cat "$WORK/cp.err")"
"$BLIFT" -q cp --overwrite "$WORK/tree/a.txt" demo:docs/2026/
[ "$("$BLIFT" cat demo:docs/renamed.txt)" = one ] || fail "cat"
# (Outputs are captured first: with pipefail, `grep -q` closing the pipe early fails the command.)
LS=$("$BLIFT" ls demo:backup 2>&1); LSR=$("$BLIFT" ls -r demo:backup 2>&1); TREE=$("$BLIFT" tree demo:backup 2>&1)
grep -q '^photos/' <<<"$LS" || fail "ls of a folder: $LS"
grep -q '3 folder(s), 1 file(s)' <<<"$LS" || fail "ls summary: $LS"
[ "$(grep -c 'c.txt' <<<"$LSR")" = 2 ] || fail "ls -r: $LSR"
grep -q '^tree/photos/2026/c.txt' <<<"$LSR" || fail "ls -r paths: $LSR"
grep -q '^docs/2026/a.txt' <<<"$("$BLIFT" ls -r demo 2>&1)" || fail "ls -r of a project"
grep -q '└── c.txt' <<<"$TREE" || fail "tree: $TREE"
grep -q '7 folder(s), 6 file(s)' <<<"$TREE" || fail "tree summary: $TREE"
grep -q folder <<<"$("$BLIFT" stat demo:backup/empty)" || fail "stat"
grep -q "no such file or folder" <<<"$("$BLIFT" stat demo:nope 2>&1 || true)" || fail "stat of a missing path"
"$BLIFT" -q mv demo:backup/tree demo:docs/                   # a folder, into a folder
"$BLIFT" -q mv demo:docs/renamed.txt demo:docs/2026/r.txt    # move and rename
"$BLIFT" mv demo:docs demo:docs/2026/ 2>/dev/null && fail "mv of a folder into itself"
"$BLIFT" -q mv demo:docs/b.txt demo:docs/2026/a.txt demo:docs/tree/empty/   # several, into a folder
"$BLIFT" stat demo:docs/tree/empty/a.txt >/dev/null && "$BLIFT" stat demo:docs/tree/empty/b.txt >/dev/null || fail "mv of several files"
[ "$("$BLIFT" cat demo:docs/2026/r.txt)" = one ] || fail "mv + rename"
"$BLIFT" stat demo:docs/tree/photos/2026/c.txt >/dev/null || fail "mv of a folder kept its contents"
comp ls demo:do | grep -q '^demo:docs/	' || fail "complete a folder: $(comp ls demo:do)"
comp cat demo:docs/2026/ | grep -q '^demo:docs/2026/r.txt	' || fail "complete inside a folder: $(comp cat demo:docs/2026/)"
[ "$(comp rm demo docs/2026/ | cut -f1)" = "docs/2026/r.txt" ] || fail "complete paths after a bare project: $(comp rm demo docs/2026/)"
"$BLIFT" -q cp -r demo:backup "$WORK/dl"                     # a folder keeps its name…
cmp "$WORK/tree/photos/2026/c.txt" "$WORK/dl/backup/photos/2026/c.txt" || fail "cp -r download"
[ -d "$WORK/dl/backup/empty" ] || fail "cp -r skipped an empty folder"
"$BLIFT" -q cp -r demo:backup/ "$WORK/dl2"                   # …unless its contents are meant
cmp "$WORK/tree/a.txt" "$WORK/dl2/a.txt" || fail "cp -r of a folder's contents"
"$BLIFT" -q cp demo:docs/2026/r.txt "$WORK/r-back.txt" && cmp "$WORK/tree/a.txt" "$WORK/r-back.txt" || fail "cp of one file to a new name"
"$BLIFT" -q download demo docs/2026/r.txt -o "$WORK/dl3/" && cmp "$WORK/tree/a.txt" "$WORK/dl3/r.txt" || fail "download by path"
"$BLIFT" cp -r demo:backup 2>/dev/null && fail "cp with one argument"
grep -q "is a folder (use -r)" <<<"$("$BLIFT" cp demo:backup "$WORK/x" 2>&1 || true)" || fail "cp of a folder without -r"
ok "folders: mkdir, cp both ways (-r, rename, contents), ls -r, tree, stat, cat, mv, completion"

# Sharing a folder: share get downloads it with its structure; an inbox can point at a folder.
DSHARE=$("$BLIFT" share create demo:backup 2>/dev/null) || fail "share create of a folder"
"$BLIFT" -q share get "$DSHARE" -o "$WORK/dshare"
cmp "$WORK/tree/photos/2026/c.txt" "$WORK/dshare/photos/2026/c.txt" || fail "share get of a folder: $(find "$WORK/dshare")"
"$BLIFT" -q share get "$DSHARE" photos/b.txt -o "$WORK/dshare2" && cmp "$WORK/tree/photos/b.txt" "$WORK/dshare2/photos/b.txt" || fail "share get of one path"
DINBOX=$("$BLIFT" share create demo:backup/empty --upload 2>/dev/null) || fail "share create --upload of a folder"
"$BLIFT" -q share put "$DINBOX" "$WORK/note.txt"
[ "$("$BLIFT" cat demo:backup/empty/note.txt)" = "dropped off" ] || fail "inbox into a folder"
grep -q "is a folder (use -r)" <<<"$("$BLIFT" rm demo:backup -y 2>&1 || true)" || fail "rm of a folder without -r"
"$BLIFT" -q rm -r demo:backup demo:docs -y
grep -q 'backup/\|docs/' <<<"$("$BLIFT" ls demo)" && fail "rm -r"
"$BLIFT" share get "$DSHARE" -o "$WORK/gone" 2>/dev/null && fail "share of a deleted folder still works"
ok "folder shares: share get keeps the structure, inbox into a folder, rm -r"

# Self-update through this server (latest release lookup + download relay); a copy is replaced.
"$BLIFT" update --check >/dev/null || fail "update --check"
cp "$BLIFT" "$WORK/blift-copy"
"$WORK/blift-copy" -q update --version 0.1.0 || fail "update --version"
"$WORK/blift-copy" version | grep -q '^blift v0.1.0 ' || fail "updated copy: $("$WORK/blift-copy" version)"
ok "blift update (check, then v0.1.0 via the server relay)"

"$BLIFT" -q rm demo big.bin -y
"$BLIFT" ls demo | grep -q big.bin && fail "rm"
"$BLIFT" -q project rm demo -y
"$BLIFT" --lang zh project ls >/dev/null
"$BLIFT" logout >/dev/null
"$BLIFT" whoami >/dev/null 2>&1 && fail "still logged in after logout"
ok "rm, project rm, logout"
echo "all CLI checks passed"
