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
j -X POST "$BASE/api/admin/storages" -d "{\"name\":\"local\",\"provider\":\"rustfs\",\"endpoint\":\"$S3_ENDPOINT\",\"region\":\"us-east-1\",\"bucket\":\"$S3_BUCKET\",\"access_key_id\":\"$S3_ACCESS_KEY\",\"secret_access_key\":\"$S3_SECRET_KEY\",\"prefix\":\"cli\"}" >/dev/null
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

"$BLIFT" project create demo -d "cli smoke" >/dev/null
"$BLIFT" project ls | grep -q demo || fail "project ls"
ok "project create / ls"

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
ok "shell completion: projects, files by prefix, flags"

"$BLIFT" ls demo --limit 1 2>"$WORK/ls.err" | grep -c 'greeting.txt\|big.bin' | grep -qx 1 || fail "ls --limit"
grep -q "showing 1 of 2" "$WORK/ls.err" || fail "ls --limit hint: $(cat "$WORK/ls.err")"
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
