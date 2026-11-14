# blift — see `make help`. Requires: node ≥ 22.13 + pnpm, go ≥ 1.26, docker (smoke/docker targets).
SHELL := /bin/bash
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
IMAGE ?= blift
CLI_PLATFORMS ?= linux/amd64 linux/arm64 darwin/amd64 darwin/arm64
LDFLAGS := -s -w -X main.version=$(VERSION)
WRANGLER := pnpm --filter server exec wrangler
# Your deployment's config (D1 id, custom domain, PUBLIC_URL) is server/wrangler.local.toml: git-ignored,
# created by `make cf-init`. Without it the committed template server/wrangler.toml is used.
# (Recursive "=" so it is evaluated after cf-init has created the file.)
WRANGLER_CONFIG = $(if $(wildcard server/wrangler.local.toml),wrangler.local.toml,wrangler.toml)

.DEFAULT_GOAL := help
.PHONY: help install dev dev-server dev-web dev-worker build build-web build-server cli cli-all cli-dist \
        test test-server test-cli typecheck smoke docker docker-up cf-init cf-config cf-secrets preview deploy clean

help: ## Show this help
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install JS dependencies (pnpm workspace: server + web)
	pnpm install

# ---- Development -----------------------------------------------------------

dev: ## Run API (Node, :8787) and web (Vite, :5173) with hot reload
	@trap 'kill 0' INT TERM EXIT; $(MAKE) --no-print-directory dev-server & $(MAKE) --no-print-directory dev-web & wait

dev-server: ## Run only the API on Node (SQLite in ./data, BOOTSTRAP_SECRET printed on first start)
	cd server && DATA_DIR=../data PORT=8787 pnpm dev

dev-web: ## Run only the Vite dev server (proxies /api to :8787)
	pnpm --filter web dev

dev-worker: build-web ## Run the real Workers runtime locally (wrangler dev, local D1); needs server/.dev.vars
	cd server && pnpm exec wrangler dev --config $(WRANGLER_CONFIG) --port 8787

# ---- Build -----------------------------------------------------------------

build: build-web build-server cli ## Build web, Node server bundle and the CLI for this machine

build-web: ## Build the SPA into web/dist
	pnpm --filter web build

build-server: ## Bundle the Node/Docker server into server/dist/server.mjs
	pnpm --filter server build

cli: ## Build the CLI for this machine into bin/blift
	cd cli && CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o ../bin/blift ./cmd/blift

cli-all: ## Cross-compile static CLI binaries into bin/blift-<os>-<arch>
	@for p in $(CLI_PLATFORMS); do os=$${p%/*}; arch=$${p#*/}; echo "→ bin/blift-$$os-$$arch"; \
	  (cd cli && CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" -o ../bin/blift-$$os-$$arch ./cmd/blift) || exit 1; done

cli-dist: cli-all ## Package the CLI as release archives + SHA256SUMS in dist/release (VERSION=vX.Y.Z)
	@mkdir -p dist/pkg dist/release
	@for p in $(CLI_PLATFORMS); do os=$${p%/*}; arch=$${p#*/}; n=blift_$(VERSION:v%=%)_$${os}_$${arch}; \
	  mkdir -p dist/pkg/$$n && cp bin/blift-$$os-$$arch dist/pkg/$$n/blift && cp LICENSE README.md dist/pkg/$$n/ && \
	  tar -C dist/pkg -czf dist/release/$$n.tar.gz $$n && echo "→ dist/release/$$n.tar.gz" || exit 1; done
	@cd dist/release && shasum -a 256 blift_$(VERSION:v%=%)_*.tar.gz > SHA256SUMS

# ---- Quality ---------------------------------------------------------------

test: typecheck test-server test-cli ## Typecheck + unit tests (server and CLI)

typecheck: ## TypeScript typecheck (server + web)
	pnpm -r typecheck

test-server: ## Server unit tests (vitest)
	pnpm --filter server test

test-cli: ## CLI unit tests + go vet
	cd cli && go test ./... && go vet ./...

smoke: ## End-to-end API + CLI tests against a throwaway RustFS container
	scripts/smoke.sh

# ---- Docker ----------------------------------------------------------------

docker: ## Build the Docker image (tags <version> and latest)
	docker build -f deploy/Dockerfile -t $(IMAGE):$(VERSION) -t $(IMAGE):latest .

docker-up: docker ## Build the image and start it with docker compose (deploy/docker-compose.yml)
	BLIFT_IMAGE=$(IMAGE):latest docker compose -f deploy/docker-compose.yml up -d

# ---- Cloudflare Workers ----------------------------------------------------

cf-init: ## Create the D1 database and write its id into server/wrangler.local.toml (git-ignored)
	@test -f server/wrangler.local.toml || cp server/wrangler.toml server/wrangler.local.toml
	@id=$$($(WRANGLER) d1 create blift 2>&1 | tee /dev/stderr | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1); \
	  test -n "$$id" || { echo "could not create D1 database"; exit 1; }; \
	  sed -i.bak -E "s/^database_id = .*/database_id = \"$$id\"/" server/wrangler.local.toml && rm server/wrangler.local.toml.bak; \
	  echo "database_id = $$id written to server/wrangler.local.toml"

cf-config: ## Write server/wrangler.local.toml from CF_D1_ID [CF_DOMAIN] [PUBLIC_URL] (for CI / Workers Builds)
	@scripts/cf-config.sh

cf-secrets: ## Generate APP_SECRET and BOOTSTRAP_SECRET and store them as Worker secrets
	@openssl rand -base64 48 | tr -d '\n' | $(WRANGLER) secret put APP_SECRET --config $(WRANGLER_CONFIG)
	@b=$$(openssl rand -hex 16); printf %s "$$b" | $(WRANGLER) secret put BOOTSTRAP_SECRET --config $(WRANGLER_CONFIG); \
	  echo; echo "  Bootstrap secret (open /setup once deployed): $$b"; echo

preview: build-web ## Deploy a Worker Preview of this branch (wrangler preview; needs CF_PREVIEW_D1_ID in cf-config)
	cd server && pnpm exec wrangler preview --config $(WRANGLER_CONFIG)

deploy: build-web ## Deploy to Cloudflare Workers (API + static assets + cron GC)
	cd server && pnpm exec wrangler deploy --config $(WRANGLER_CONFIG)

clean: ## Remove build outputs
	/bin/rm -rf bin web/dist server/dist
