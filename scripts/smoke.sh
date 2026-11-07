#!/usr/bin/env bash
# End-to-end smoke tests: a throwaway RustFS (S3) container, then
#   1. API test  (server/test/smoke.mjs)     against a fresh server
#   2. CLI test  (server/test/cli-smoke.sh)  against another fresh server
# Uses server/dist/server.mjs when built (make build-server), else tsx.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

PORT=${SMOKE_PORT:-18787}
S3_PORT=${SMOKE_S3_PORT:-19100}
S3_NAME=blift-smoke-s3
TMP=$(mktemp -d)
SERVER_PID=""
export BOOTSTRAP_SECRET=smoke-bootstrap S3_ENDPOINT="http://localhost:$S3_PORT" S3_BUCKET=smoke \
  S3_ACCESS_KEY=smoke S3_SECRET_KEY=smoke-secret-key BASE="http://localhost:$PORT"

stop_server() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""; }
cleanup() { stop_server; docker rm -f "$S3_NAME" >/dev/null 2>&1 || true; /bin/rm -rf "$TMP"; }
trap cleanup EXIT

start_server() { # $1 = data dir
  mkdir -p "$1"
  (cd server && if [ -f dist/server.mjs ]; then exec env DATA_DIR="$1" PORT=$PORT node dist/server.mjs; else exec env DATA_DIR="$1" PORT=$PORT node --import tsx src/node.ts; fi) >"$1/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do curl -sf "$BASE/api/health" >/dev/null && return; sleep 0.5; done
  cat "$1/server.log"; exit 1
}

echo "→ RustFS on :$S3_PORT"
docker rm -f "$S3_NAME" >/dev/null 2>&1 || true
docker run -d --name "$S3_NAME" -p "$S3_PORT:9000" -e RUSTFS_ACCESS_KEY=$S3_ACCESS_KEY -e RUSTFS_SECRET_KEY=$S3_SECRET_KEY \
  rustfs/rustfs:latest >/dev/null
for _ in $(seq 1 40); do curl -s -o /dev/null "$S3_ENDPOINT/" && break; sleep 0.5; done

echo "→ [1/2] API smoke"
start_server "$TMP/api"
(cd server && CREATE_BUCKET=1 node test/smoke.mjs) || { cat "$TMP/api/server.log"; exit 1; }
stop_server

echo "→ [2/2] CLI smoke"
BLIFT=${BLIFT:-$ROOT/bin/blift}
[ -x "$BLIFT" ] || (cd cli && go build -o "$BLIFT" ./cmd/blift)
start_server "$TMP/cli"
BLIFT="$BLIFT" bash server/test/cli-smoke.sh || { cat "$TMP/cli/server.log"; exit 1; }
