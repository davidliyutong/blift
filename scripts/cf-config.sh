#!/usr/bin/env bash
# Writes server/wrangler.local.toml from the committed template and the environment, for
# deployments without a checked-out personal config (CI, Cloudflare Workers Builds):
#   CF_D1_ID    D1 database id (required)
#   CF_DOMAIN   custom domain, e.g. files.example.com (optional; keeps *.workers.dev on too)
#   PUBLIC_URL  canonical origin, e.g. https://files.example.com (optional)
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
echo "server/wrangler.local.toml written"
