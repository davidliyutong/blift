#!/usr/bin/env bash
# Writes server/wrangler.local.toml from the committed template and the environment, for
# deployments without a checked-out personal config (CI, Cloudflare Workers Builds):
#   CF_D1_ID    D1 database id (required)
#   CF_DOMAIN   custom domain, e.g. files.example.com (optional; keeps *.workers.dev on too)
#   PUBLIC_URL  canonical origin, e.g. https://files.example.com (optional)
#   CF_PREVIEW_D1_ID  D1 database id for Worker Previews (`make preview` on other branches;
#               optional). A database of its own: a preview applies its branch's migrations.
set -euo pipefail
cd "$(dirname "$0")/../server"

: "${CF_D1_ID:?CF_D1_ID is required (the D1 database id)}"
args=(-e "s|^database_id = .*|database_id = \"$CF_D1_ID\"|")
if [ -n "${CF_DOMAIN:-}" ]; then
  args+=(-e "s|^# routes = .*|routes = [{ pattern = \"$CF_DOMAIN\", custom_domain = true }]|"
         -e "s|^# workers_dev = true|workers_dev = true|")
fi
if [ -n "${PUBLIC_URL:-}" ]; then
  args+=(-e "s|^# \[vars\]|[vars]|" -e "s|^# PUBLIC_URL = .*|PUBLIC_URL = \"$PUBLIC_URL\"|")
fi
sed -E "${args[@]}" wrangler.toml > wrangler.local.toml
if [ -n "${CF_PREVIEW_D1_ID:-}" ]; then
  [ "$CF_PREVIEW_D1_ID" != "$CF_D1_ID" ] || { echo "CF_PREVIEW_D1_ID must not be the production database" >&2; exit 1; }
  printf '\n# Worker Previews (wrangler preview) use their own database.\n[[previews.d1_databases]]\nbinding = "DB"\ndatabase_id = "%s"\n' "$CF_PREVIEW_D1_ID" >> wrangler.local.toml
fi
echo "server/wrangler.local.toml written"
