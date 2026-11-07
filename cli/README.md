# blift CLI

blift 的命令行客户端（Go，单一静态二进制，支持 Linux/macOS × amd64/arm64）。
文件不经过服务器：上传、下载都通过服务器签发的 S3 预签名 URL 直连对象存储。

## 安装

```sh
curl -fsSL https://<你的 blift 服务器>/install.sh | sh
```

安装与该服务器版本一致的 CLI：经服务器中转 GitHub Release 下载（失败时直连 GitHub），校验 SHA-256。可选环境变量：
`BLIFT_INSTALL_DIR`（安装目录，默认 `~/.local/bin`）、`BLIFT_VERSION`（指定版本）、`BLIFT_DOWNLOAD_URL`（只从该镜像下载）。

## 构建与测试

```sh
cd cli
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=v0.1.0" -o ../bin/blift ./cmd/blift
go test ./... && go vet ./...
```

## 配置

- 配置文件：`$XDG_CONFIG_HOME/blift/config.json`（默认 `~/.config/blift/config.json`，权限 0600），保存 `server`、`token`、`user`。
- 环境变量：`BLIFT_SERVER`、`BLIFT_TOKEN`、`BLIFT_LANG`（`zh` / `en`）。
- 全局参数：`--server URL`、`--lang zh|en`、`--json`（输出原始 JSON）、`-q/--quiet`。
- 语言优先级：`--lang` > `BLIFT_LANG` > `LC_ALL` / `LC_MESSAGES` / `LANG`（以 `zh` 开头即中文）> 英文。
- 保存的令牌只会发给签发它的服务器；`BLIFT_TOKEN` 总是优先。

## 命令

| 命令 | 说明 |
| --- | --- |
| `blift login [--server URL] [--no-browser] [--token T]` | 浏览器设备码授权登录，或直接使用令牌 |
| `blift logout` / `whoami` / `version` | 退出、查看当前用户、版本 |
| `blift project ls\|create\|info\|rm\|rename\|members\|add-member\|rm-member` | 项目管理（别名 `projects`、`p`） |
| `blift ls <项目> [--sort name\|size\|time] [--query 文本] [-n 100] [-a]` | 列出文件（默认最多 100 个，`-n/--limit` 调整，`-a/--all` 全部） |
| `blift upload <项目> <文件>... [--name N] [--overwrite] [-j 4]` | 上传（别名 `up`、`push`） |
| `blift download <项目> [文件...] [--all] [-o 目录或文件] [-j 4]` | 下载（别名 `dl`、`pull`） |
| `blift rm <项目> <文件>... [-y]` | 删除文件 |
| `blift mv <项目> <文件> <新名称>` | 重命名文件 |
| `blift url <项目> <文件>` | 输出预签名下载链接（1 小时有效） |
| `blift share create <项目> [文件] [--password P] [--expires 7d] [--max-downloads N]` | 创建分享（不指定文件即分享整个项目） |
| `blift share ls [项目]` / `share rm <分享ID>` | 列出 / 删除分享 |
| `blift share get <分享链接或token> [文件...] [--password P] [-o 目录]` | 免登录从分享链接下载 |
| `blift update [--check] [--version X.Y.Z] [--force]` | 原地更新到最新版本（别名 `upgrade`） |

项目参数可以是 ID、名称或 `所有者/名称`：ID 精确匹配优先；同名时优先自己拥有的项目，仍有歧义则报错并列出候选。
文件参数可以是文件名或 ID（按名称精确查找，项目再大也只需一次请求）。

## 更新

`blift update` 把当前二进制原地替换为最新版本：先向已配置的 blift 服务器查询最新版本、经它中转下载，
失败时直连 GitHub（与 install.sh 相同，`BLIFT_DOWNLOAD_URL` 可指定镜像）；按 `SHA256SUMS` 校验通过后
才替换。`--check` 只检查，`--version` 安装指定版本（可降级），装在需要 root 的目录时用 `sudo blift update`。

## Shell 补全

补全项目名、文件名（按已输入的前缀向服务器查询）、分享 ID、成员与用户，以及 `--sort`、`--role`、
`--storage`、`--expires`、`--lang` 等参数值：

```sh
# zsh（确保 fpath 中的目录在 compinit 之前）
blift completion zsh > "${fpath[1]}/_blift"
# bash（需要 bash-completion）
blift completion bash > ~/.local/share/bash-completion/completions/blift
# fish
blift completion fish > ~/.config/fish/completions/blift.fish
```

## 示例

```sh
blift login --server https://files.example.com     # 打开浏览器确认授权
blift p create datasets -d "训练数据"
blift up datasets ./model.ckpt ./notes.md -j 8      # >64 MiB 自动分片并行上传
blift up datasets ./dist                            # 目录：只上传其中的普通文件（不递归）
blift ls datasets --sort size -n 20                 # 最大的 20 个文件
blift ls datasets --query ckpt --all                # 名称包含 ckpt 的全部文件
blift dl datasets model.ckpt -o ~/Downloads/        # >64 MiB 使用并行 Range 下载
blift dl datasets --all -o ./backup
blift share create datasets model.ckpt --password 1234 --expires 7d
blift share get https://files.example.com/s/AbCd123 --password 1234 -o .
blift --json ls datasets | jq '.[].name'
```

## 行为说明

- 上传：先 `init`，服务器决定单次 PUT（≤ 64 MiB）或分片；分片 URL 每批最多 100 个，按 `-j` 并发上传，每片失败重试 3 次（指数退避），最后带 ETag 列表 `complete`。失败或 Ctrl-C 时调用 `DELETE /api/uploads/:id` 取消。
- 下载：先写入 `<目标>.part`，成功后改名；失败时删除临时文件。
- 多个文件中个别失败时会继续处理其余文件，最后以非零状态退出。
- 进度条仅在 stderr 为终端且未使用 `-q` 时显示；状态信息写 stderr，表格 / JSON 写 stdout。
