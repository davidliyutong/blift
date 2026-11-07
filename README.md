# blift

轻量的内部文件共享 / 传输系统，以 S3 兼容对象存储为后端。
原生运行在 **Cloudflare Workers**（D1 + Workers Assets + Cron），也可以用 **Docker** 自托管（Node + SQLite）。

*A lightweight internal file-sharing service on top of S3-compatible storage. Runs natively on
Cloudflare Workers or in Docker. Web UI (Cloudflare Kumo design system, 中文/English) and a
single-binary Go CLI with browser-based login.*

- **极简结构**：只有 `project → blob` 两级，没有文件夹树。
- **直传**：上传、下载都通过预签名 URL 直接在客户端与 S3 之间进行，服务端只负责签名和记账；大文件自动分片并行上传 / 分段并行下载。
- **存储后端**：Cloudflare R2、Backblaze B2、AWS S3、RustFS、MinIO 等任何 S3 兼容存储，可配置多个，按项目选择。
- **分享**：公开链接（单个文件或整个项目），可设置访问密码、有效期、下载次数上限。
- **账号**：OIDC 登录（优先适配 Authentik，ID Token 支持 HS256 / RS256 / ES256），新用户首次登录自动注册；本地密码账号用于初始管理员；TOTP 两步验证。
- **管理**：一次性 bootstrap secret 自助创建管理员；在线配置存储后端与 OIDC；仪表盘查看用量、请求数、流量；用户管理与配额调整。
- **CLI**：`blift login` 像 `gh` 一样在浏览器里授权；管理项目、上传下载、分享；Linux / macOS × amd64 / arm64 静态单文件。
- **垃圾回收**：未完成的上传、已删除的文件与项目、过期会话与分享由定时任务清理。

## 目录结构

```
server/   API（TypeScript + Hono），同一份代码跑在 Workers 和 Node 上
web/      Web 前端（React + @cloudflare/kumo，中英双语）
cli/      Go 命令行客户端
docs/     API.md —— 服务端 / Web / CLI 三方共同遵守的接口契约
deploy/   Dockerfile、docker-compose.yml
scripts/  smoke.sh —— 端到端测试（RustFS 容器 + 真实服务端 + CLI）
```

## 快速开始（本地开发）

```bash
make install        # pnpm install
make dev            # API :8787（Node + SQLite，数据在 ./data）+ Web :5173
```

首次启动时终端会打印 bootstrap secret（也保存在 `data/bootstrap-secret`）。打开 <http://localhost:5173/setup>
创建管理员，然后在「管理 → 存储」里添加一个存储后端。本地试用可以起一个 RustFS：

```bash
docker run -d -p 9000:9000 -e RUSTFS_ACCESS_KEY=blift -e RUSTFS_SECRET_KEY=blift-secret rustfs/rustfs
# 存储配置：endpoint http://localhost:9000，region us-east-1，path-style 开启，再点「应用 CORS」
```

常用目标见 `make help`：`make test`（类型检查 + 单元测试）、`make smoke`（端到端）、`make build`、`make cli-all`。

## 部署到 Cloudflare Workers

```bash
make install
pnpm --filter server exec wrangler login
make cf-init        # 创建 D1 数据库，生成 server/wrangler.local.toml（git 忽略）并写入其 ID
make cf-secrets     # 生成 APP_SECRET 与 BOOTSTRAP_SECRET（会打印后者）
make deploy         # 构建前端并 wrangler deploy（API + 静态资源 + 每 15 分钟的 GC Cron）
```

数据库迁移在 Worker 第一次处理请求时自动执行，无需手动 `d1 migrations apply`。
仓库里的 `server/wrangler.toml` 只是模板；你自己的部署配置（D1 ID、自定义域名、`PUBLIC_URL`）放在
`server/wrangler.local.toml`，它被 git 忽略，Makefile 中的 wrangler 命令会自动优先使用它。

自定义域名：在 `wrangler.local.toml` 中加 `routes = [{ pattern = "files.example.com", custom_domain = true }]`，
并同时写 `workers_dev = true`（否则 wrangler 会关闭 `*.workers.dev` 地址）。Worker 有多个域名时，在 `[vars]`
中设置 `PUBLIC_URL` 作为规范地址：OIDC 回调、分享链接和 CLI 登录链接都会使用它。

## Docker 部署

```bash
make docker                                   # 构建镜像 blift:latest
docker run -d -p 8080:8080 -v blift-data:/data -e PUBLIC_URL=https://files.example.com blift
docker logs <container>                       # 首次启动会打印 bootstrap secret
```

或使用 `deploy/docker-compose.yml`（含可选的 RustFS，`--profile s3`）。所有状态都在 `/data`
（SQLite 数据库 + 自动生成的 `app-secret`），请备份该卷：丢失 `APP_SECRET` 会导致已保存的 S3 / OIDC 密钥无法解密。

| 环境变量 | 说明 |
| --- | --- |
| `PUBLIC_URL` | 对外访问地址，用于分享链接、OIDC 回调、CLI 登录链接。默认取请求的 Host / `X-Forwarded-*` |
| `BOOTSTRAP_SECRET` | 一次性管理员注册密钥；不设置则自动生成到 `/data/bootstrap-secret`。存在活跃管理员后即失效 |
| `APP_SECRET` | 会话签名与凭据加密密钥；不设置则自动生成到 `/data/app-secret` |
| `PORT` / `DATA_DIR` / `WEB_DIR` | 默认 `8080` / `/data` / `/app/web` |
| `GC_BUDGET` | 每轮 GC 最多发起的 S3 请求数（Node 默认 1000，Workers 默认 40） |

## 配置存储后端

浏览器会直接向存储发起 `PUT` / `GET`，因此 **bucket 必须允许 Web 页面所在源的 CORS**（允许 `GET, PUT, HEAD`，
Header `*`）。管理页里的「应用 CORS」会调用 `PutBucketCors` 自动配置；不支持该接口的服务需在其控制台配置。
存储的 endpoint 必须能被服务端和用户浏览器以**同一个地址**访问（预签名 URL 绑定了 Host）。

| 服务 | Endpoint | Region | Path-style | 备注 |
| --- | --- | --- | --- | --- |
| Cloudflare R2 | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | `auto` | 开 | R2 API Token（Object Read & Write） |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | 如 `us-west-004` | 开 | 必须设生命周期，见下文 |
| AWS S3 | `https://s3.<region>.amazonaws.com` | 如 `us-east-1` | 关 | |
| RustFS / MinIO | `http(s)://<host>:9000` | `us-east-1` | 开 | |

建议在 bucket 上再加一条生命周期规则「2 天后中止未完成的分片上传」作为兜底（GC 已会处理，属于双保险）。

### Backblaze B2

1. **建桶**：Files in Bucket 选 **Private**，不要开 Object Lock。Endpoint 与 Region 见桶详情页的
   「Endpoint」（如 `s3.us-west-004.backblazeb2.com` → Region `us-west-004`）。
2. **生命周期（必须）**：桶设置 → Lifecycle Settings → **Keep only the last version of the file**。
   B2 总是保留所有版本，S3 接口的删除（不带 VersionId）只会插入隐藏标记；不设此规则，GC 删掉的文件会一直占用空间、产生费用。
   设置后被隐藏的版本 1 天后真正删除。
3. **Application Key**：限定到该桶、Read and Write 即可（需要 readFiles / writeFiles / deleteFiles / listFiles）。
   B2 的主密钥（master key）不能用于 S3 接口。
4. **CORS**：B2 控制台里的 CORS 预设只允许下载，不含上传用的 `PUT`。二选一：
   - 用一个**不限定桶**的 Read and Write 密钥（含 `writeBuckets`）点「应用 CORS」，之后可换回限定桶的密钥；
   - 或用 [b2 CLI](https://www.backblaze.com/docs/cloud-storage-command-line-tools) 设置（`<bucket>` 与域名替换为实际值）：

     ```bash
     b2 account authorize
     b2 bucket update <bucket> allPrivate --cors-rules '[{"corsRuleName":"blift","allowedOrigins":["https://<你的域名>"],
       "allowedOperations":["s3_get","s3_head","s3_put"],"allowedHeaders":["*"],"exposeHeaders":["ETag"],"maxAgeSeconds":3600}]'
     ```
5. 下载走预签名 URL 直连 B2，不经过 Cloudflare，因此不享受 Bandwidth Alliance 免流量；B2 每月免费出口流量为存储量的 3 倍。

## 对接 OIDC（Authentik）

1. Authentik → Applications → Providers → 新建 **OAuth2/OpenID Provider**：Client type `Confidential`，
   Redirect URI 填管理页显示的回调地址 `https://<你的域名>/api/auth/oidc/callback`；
   Signing Key 选一个证书则 ID Token 为 **RS256**，留空则为 **HS256**（以 client secret 签名），两者都支持。
2. 新建 Application 绑定该 Provider，记下 slug。
3. blift → 管理 → 设置 → OIDC：Issuer 填 `https://<authentik>/application/o/<slug>/`，填入 Client ID / Secret，
   Scopes 保持 `openid profile email`，可点「测试」检查 discovery。
4. 可选「管理员组」：例如 `blift-admins`，该组成员（`groups` claim）登录时自动成为管理员。

新用户首次 OIDC 登录即自动注册（默认配额见设置）；若邮箱与已有的本地账号一致，则自动关联到该账号。
开启了 TOTP 的用户在 OIDC 登录后仍需输入验证码。

## CLI

```bash
make cli            # 或 make cli-all 交叉编译 linux/darwin × amd64/arm64 到 bin/
blift login --server https://files.example.com     # 打开浏览器授权（--no-browser 只打印链接）
blift project create demo
blift upload demo ./build.tar.gz ./notes.md -j 8
blift ls demo
blift download demo build.tar.gz -o ./out/
blift share create demo build.tar.gz --password 1234 --expires 7d
blift share get https://files.example.com/s/AbCdEf123456 --password 1234    # 无需登录
```

更多见 [cli/README.md](cli/README.md)。界面语言跟随 `LANG`，或用 `--lang zh|en` / `BLIFT_LANG`。

## 设计取舍与 Cloudflare 限制

- 文件字节从不经过 Worker（Workers 请求体上限 100 MB、CPU 时间宝贵）：单文件 ≤ 64 MiB 直接预签名 PUT，更大的走分片（固定分片大小 ≥ 16 MiB，满足 R2 等长分片要求，最多 10 000 片）。
- 分片 URL 按每批 ≤ 100 个签发，纯本地签名，不产生子请求；完成上传时服务端用 `ListParts` 自行收集 ETag，并 `HEAD` 校验实际大小后才计入配额。
- GC 每轮的 S3 请求数受预算控制（免费版 Workers 每次调用 50 个子请求），删除使用 `DeleteObjects` 每次 1000 个 key，出站并发 ≤ 6。
- D1：单条语句绑定参数 ≤ 100，`IN (...)` 自动分块；多语句写入用 `batch` 保证原子性；统计计数每请求一次 upsert 且在 `waitUntil` 中执行；会话最近使用时间 5 分钟才写一次。
- 静态资源由 Workers Assets 直接返回，不消耗 Worker 调用。
- 密码使用 PBKDF2-SHA256 10 万次迭代（Workers 上限）；免费版 10 ms CPU 限制下密码登录可能偶发超时，生产建议付费版或使用 OIDC。
- 删除是异步的：删除文件 / 项目立即释放配额并从列表消失，对象由 GC 清理；用量计数每日按实际数据校准一次。
- 下载流量按签发下载链接时的文件大小统计（数据不经过服务端，无法精确计量）。

## 许可

内部项目。
