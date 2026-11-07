# AGENTS.md — 给在本仓库工作的 Agent 的说明

blift 是一个以 S3 兼容对象存储为后端的内部文件共享 / 传输系统。三个可交付物共用一个 API 契约：

| 目录 | 内容 | 技术 |
| --- | --- | --- |
| `server/` | HTTP API（同一份代码跑在 Cloudflare Workers 与 Node/Docker） | TypeScript, Hono, jose, aws4fetch |
| `web/` | SPA 前端 | React 19, Vite, Tailwind v4, `@cloudflare/kumo`, react-router 7 |
| `cli/` | 命令行客户端 | Go, cobra，`CGO_ENABLED=0` 单文件 |
| `docs/API.md` | **接口契约（唯一事实来源）** | — |

## 常用命令

```bash
make install       # pnpm install（workspace: server, web）
make dev           # API :8787 (Node+SQLite, ./data) + Vite :5173（/api 代理到 8787）
make test          # pnpm -r typecheck + vitest + go test/vet —— 提交前必须通过
make smoke         # 端到端：起 RustFS 容器 + 新库服务端，跑 server/test/smoke.mjs 和 cli-smoke.sh（需要 docker）
make build         # web/dist + server/dist/server.mjs + bin/blift
make dev-worker    # 用 wrangler dev 在真实 Workers 运行时（本地 D1）上跑；需要 server/.dev.vars
make deploy        # 部署到 Workers；优先使用 git 忽略的 server/wrangler.local.toml（个人部署配置）
```

改了 API 行为就跑 `make smoke`；只改 UI 至少跑 `pnpm --filter web build`。
`server/wrangler.toml` 是提交到仓库的通用模板，不要写入真实的 D1 ID、域名或 `PUBLIC_URL`；这些放在 `server/wrangler.local.toml`（CI 会检查）。

CI（`.github/workflows/ci.yml`）在 PR 和 main 上跑 `make test`、`make build cli-all`、`make smoke` 和 Docker 构建。
发版由 `v*` 标签触发（`.github/workflows/release.yml`）：CLI 压缩包 + SHA256SUMS + GHCR 多架构镜像 + GitHub Release，
标签必须与 `server/src/version.ts` 和 `CHANGELOG.md` 一致，步骤见 `RELEASING.md`。用户可见的改动记到 `CHANGELOG.md` 的 `[Unreleased]`。
README 有英文（`README.md`）和中文（`README.zh-CN.md`）两份，改功能时同步更新。

## 修改 API 的流程

1. 先改 `docs/API.md`。
2. 服务端：`server/src/routes/*`。
3. 前端：`web/src/api/types.ts`（类型镜像 API.md）与调用处。
4. CLI：`cli/internal/api/{types,methods}.go`。
5. 新增错误码时，同时在 `web/src/i18n/{en,zh}.ts` 和 `cli/internal/i18n/messages.go` 加翻译。
6. 在 `server/test/smoke.mjs` 补一条端到端断言。

## 服务端架构（`server/src`）

- `app.ts` 组装 Hono 应用（basePath `/api`）；`worker.ts` 是 Workers 入口（fetch + scheduled GC）；`node.ts` 是 Docker 入口（node:sqlite、静态文件、定时 GC、自动生成 secret）。
- `db/index.ts` 定义的 `DB` 接口是 **D1 API 的子集**；`db/node-sqlite.ts` 在 Node 上实现它。只用 `one/all/run/stmt` 辅助函数和 `db.batch()`，不要引入 ORM。
- `db/migrations.ts`：迁移**只追加、不修改**；启动/首个请求时自动执行。刻意不声明外键（D1 强制外键，而删除是异步的），引用清理在代码里显式做。
- 状态机：
  - blob：`pending`（已签发上传）→ `active`（complete 时 HEAD 校验大小）→ `deleted`（GC 删除对象后删行）。
  - project：`active` → `deleting`（blob 全部标记删除、配额立即释放）→ GC 在其 blob 清空后删行。
- 配额/用量：`projects.used_bytes/blob_count` 与 `users.used_bytes` 增量维护，GC 每日 `reconcile` 一次按真实数据校准。用量计入**项目所有者**。
- 权限：一律通过 `services/projects.ts` 的 `loadProject(c, id, need)` / `loadBlob(...)`；非成员返回 404。管理员对所有项目隐式拥有 owner 权限。
- 统计：处理函数调用 `addStats(c, {...})`，中间件在响应后用 **一次** upsert 写入 `stats_daily`（`waitUntil`）。
- 错误：抛 `ApiError(status, code, message)`（`lib/errors.ts`），由 `app.onError` 渲染为 `{error:{code,message}}`。`code` 是契约的一部分，客户端据此翻译。
- 安全约定：会话 token 只存 SHA-256；S3 secret、OIDC client secret、TOTP secret 用 `APP_SECRET` 派生的 AES-GCM 加密存储，永不返回给客户端；重定向只允许站内相对路径（`safeRedirect`）。

### Cloudflare 限制清单（写服务端代码时逐条自查）

- 文件字节**绝不**经过服务端：上传/下载全部是预签名 URL。
- 每次 S3 调用都是子请求（免费版每次调用 50 个）：请求路径里最多 1–2 次；批量工作放到 GC 并受 `GC_BUDGET` 约束。
- 出站并发 ≤ 6：用 `lib/http.ts` 的 `pool(items, 6, fn)`。
- D1 单语句绑定参数 ≤ 100：`IN (...)` 用 `chunks()` + `placeholders()`；多语句一致性用 `db.batch()`。
- 不要每个请求多写几次 D1：非关键写放 `c.executionCtx.waitUntil`，能合并就合并。
- CPU：避免大循环/大 JSON；PBKDF2 已是 Workers 上限 10 万次，不要再加。
- `aws4fetch` 的重试已设为 1（默认 10 会耗尽子请求预算）。

## 前端约定（`web/src`）

- 设计语言 = Cloudflare 控制台，组件全部来自 `@cloudflare/kumo`。组件 API 以包内 `node_modules/@cloudflare/kumo/ai/component-registry.md` 为准（`npx @cloudflare/kumo doc <Component>`）。
- 只用语义 token（`bg-kumo-base`、`text-kumo-subtle`、`border-kumo-line`…），**不要**用原始 Tailwind 颜色，**不要**写 `dark:` 变体（深色模式由 `data-mode` 自动处理）。图标用 `@phosphor-icons/react`。
- **所有用户可见文案走 i18n**：`src/i18n/en.ts` 与 `zh.ts` 必须同步加 key（`zh.ts` 以 `en.ts` 的类型为约束），通过 `useT()` 使用。
- `src/api/` 是类型化的 fetch 客户端；`src/lib/upload.ts` 是上传引擎（单 PUT / 分片并行 + 重试，完成时不传 parts，由服务端 ListParts）。
- echarts 只在管理仪表盘懒加载，普通用户不下载。

## CLI 约定（`cli/`）

- 入口 `cmd/blift`；命令在 `internal/cmd`，HTTP 客户端在 `internal/api`，传输引擎在 `internal/transfer`，文案在 `internal/i18n`（中英两份 map，键必须一致）。
- 依赖保持最少（cobra、x/term）。必须能 `CGO_ENABLED=0` 交叉编译 linux/darwin × amd64/arm64（`make cli-all`）。
- 配置在 `$XDG_CONFIG_HOME/blift/config.json`（0600）；`BLIFT_SERVER` / `BLIFT_TOKEN` / `BLIFT_LANG` 覆盖。

## 产品边界（不要做）

- 不做文件夹/树结构：只有 project → blob。blob 名不能含 `/`。
- 不做计费、复杂审计、限流等"企业级"功能；这是内部工具，保持轻量，不要过度防御式编程。
- 不让文件流量经过服务端（包括"代理下载"之类的便利功能）。
