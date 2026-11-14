# blift CLI

[English](README.md) | 简体中文

blift 的命令行客户端（Go，单一静态二进制，支持 Linux/macOS × amd64/arm64）。
文件不经过服务器：上传、下载都通过服务器签发的 S3 预签名 URL 直连对象存储。

## 安装

```sh
curl -fsSL https://<你的 blift 服务器>/install.sh | sh
```

安装与该服务器版本一致的 CLI：经服务器中转 GitHub Release 下载（失败时直连 GitHub），校验 SHA-256。可选环境变量：
`BLIFT_INSTALL_DIR`（安装目录，默认 `~/.local/bin`）、`BLIFT_VERSION`（指定版本）、`BLIFT_DOWNLOAD_URL`（只从该镜像下载）、
`BLIFT_API_KEY`（装完后用这个 API key 登录，适合无人值守部署：`curl -fsSL https://<服务器>/install.sh | BLIFT_API_KEY=bliftk_… sh`）。

## 构建与测试

```sh
cd cli
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=v0.1.0" -o ../bin/blift ./cmd/blift
go test ./... && go vet ./...
```

## 配置

- 配置文件：`$XDG_CONFIG_HOME/blift/config.json`（默认 `~/.config/blift/config.json`，权限 0600），保存 `server`、`token`、`user`。
- 环境变量：`BLIFT_SERVER`、`BLIFT_TOKEN`、`BLIFT_LANG`（`zh` / `en`）；`BLIFT_API_KEY` 只用于 `blift login`。
- 全局参数：`--server URL`、`--lang zh|en`、`--json`（输出原始 JSON）、`-q/--quiet`。
- 语言优先级：`--lang` > `BLIFT_LANG` > `LC_ALL` / `LC_MESSAGES` / `LANG`（以 `zh` 开头即中文）> 英文。
- 保存的令牌只会发给签发它的服务器；`BLIFT_TOKEN` 总是优先。

## 命令

| 命令 | 说明 |
| --- | --- |
| `blift login [--server URL] [--no-browser] [--token T \| --api-key K]` | 浏览器设备码授权登录；或用 API key（网页「账户设置 → API keys」创建，默认读 `BLIFT_API_KEY`）换取会话；或直接使用令牌 |
| `blift logout` / `whoami` / `version` | 退出、查看当前用户、版本 |
| `blift project ls\|create\|info\|rm\|rename\|members\|add-member\|rm-member` | 项目管理（别名 `projects`、`p`） |
| `blift ls [项目[:路径]] [-r] [--sort name\|size\|time] [--query 文本] [-n 100] [-a]` | 不带参数时列出你的项目；否则列出该文件夹，文件夹在前（默认最多 100 项，`-n/--limit` 调整，`-a/--all` 全部）；`-r` 列出其下所有文件及路径；`--query` 在整个项目中搜索 |
| `blift cp [-r] <来源>... <目标> [--overwrite] [-j 4] [-P 4]` | 在本地路径与 `项目:路径` 之间复制：上传和下载，单个文件或整棵目录树（见下文） |
| `blift mv <项目:路径>... <项目:路径>` | 在项目内移动或重命名，用法同 `mv`（别名 `rename`）；文件夹连同其中所有内容一起移动，瞬间完成 |
| `blift rm [-r] <项目:路径>... [-y]` | 删除文件；加 `-r` 删除文件夹 |
| `blift browse [项目[:路径]]` | 全屏浏览器（别名 `tui`）：一侧是服务器，一侧是本机；在一侧复制（`y`）、到另一侧粘贴（`p`）即上传或下载，在服务器上 `x` 后 `p` 为移动，`?` 查看全部按键 |
| `blift mkdir [-p] <项目:路径>...` | 创建文件夹（`-p`：连同缺少的上级） |
| `blift tree <项目[:路径]> [-L 层数]` | 以树形显示项目或文件夹 |
| `blift stat <项目:路径>` / `cat <项目:路径>` | 查看文件或文件夹的详情 / 把文件输出到标准输出 |
| `blift url <项目:路径>` | 输出预签名下载链接（1 小时有效） |
| `blift upload <项目[:目录]> <文件>... [-r] [--name N] [--overwrite]` | 上传到项目或文件夹（别名 `up`、`push`）；等同于 `cp <文件>... 项目:目录/` |
| `blift download <项目[:路径]> [路径...] [-r] [--all] [-o 目录或文件]` | 下载（别名 `dl`、`pull`）；`--all` 下载整个项目 |
| `blift share create <项目[:路径]> [--password P] [--expires 7d] [--max-downloads N]` | 分享项目、文件夹或单个文件；分享单个文件且不设密码时，还会输出可用于 `wget` / `curl` 的直接下载链接 |
| `blift share create <项目[:目录]> --upload [--password P] [--expires 7d] [--max-uploads N] [--max-size 10G]` | 创建收件箱：拿到链接的人都能向项目（或该文件夹）上传文件，但看不到里面的任何文件 |
| `blift share put <收件箱链接或token> <文件>... [--password P] [--name N] [-j 4]` | 免登录通过收件箱链接上传（重名时自动编号） |
| `blift share ls [项目]` / `share rm <分享ID>` | 列出 / 删除分享（含类型和使用情况） |
| `blift share get <分享链接或token> [路径...] [--password P] [-o 目录]` | 免登录从分享链接下载：其中的全部内容（含文件夹），或只下载指定的路径（直接下载链接只下载对应的文件） |
| `blift update [--check] [--version X.Y.Z] [--force]` | 原地更新到最新版本（别名 `upgrade`） |

### 路径

项目中的位置写作 `项目:路径`，与 `scp`、`rclone` 相同：`datasets` 或 `datasets:` 是项目本身，
`datasets:runs/42/model.ckpt` 是文件，`datasets:runs/` 是文件夹。项目可以是 ID、名称或 `所有者/名称`：
ID 精确匹配优先；同名时优先自己拥有的项目，仍有歧义则报错并列出候选。文件夹最多嵌套 16 层。

`blift cp` 靠这个冒号区分远端和本地，所以文件名里带冒号的本地文件要写成 `./a:b`。规则与 `cp`、`rsync` 一致：

- 目标已经是文件夹、以 `/` 结尾，或有多个来源时，目标就是文件夹：来源以各自的名字放进去，缺少的文件夹会自动创建。
  否则单个来源会被复制*成那个名字*。
- 目录需要 `-r`。目录会保留自己的名字；以斜杠结尾则表示“其中的内容”：`cp -r ./photos demo:album` 在还没有
  `album` 时把 `photos` 建成 `album`，已有时则得到 `album/photos`；`cp -r ./photos/ demo:album/` 总是把
  `photos` 里的文件直接放进 `album`。
- 同时传输 `-P` 个文件（默认 4），大文件每个再用 `-j` 个连接；多个文件共用一条进度条。
- 复制只发生在本机与项目之间。在项目内移动请用 `blift mv`，无论文件夹多大都是瞬间完成。

以项目开头的命令也接受旧写法 `<项目> <路径>...`（`blift rm demo a.txt docs/b.txt`），其中的路径也可以是文件 ID。

## 更新

`blift update` 把当前二进制原地替换为最新版本：先向已配置的 blift 服务器查询最新版本、经它中转下载，
失败时直连 GitHub（与 install.sh 相同，`BLIFT_DOWNLOAD_URL` 可指定镜像）；按 `SHA256SUMS` 校验通过后
才替换。`--check` 只检查，`--version` 安装指定版本（可降级），装在需要 root 的目录时用 `sudo blift update`。

## Shell 补全

补全项目名，以及冒号之后的路径（逐级补全文件夹，按已输入的前缀向服务器查询）、分享 ID、成员与用户，以及 `--sort`、`--role`、
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
blift cp -r ./dist datasets:builds/                 # 整棵目录树 → builds/dist/…，同时传 4 个文件
blift cp ./notes.md datasets:docs/readme.md         # 上传并改名
blift ls datasets:builds/dist --sort size -n 20     # 该文件夹，从大到小
blift ls datasets --query ckpt --all                # 项目中名称包含 ckpt 的全部文件
blift tree datasets -L 2
blift mv datasets:builds/dist datasets:releases/v1  # 无论多大都瞬间完成
blift dl datasets model.ckpt -o ~/Downloads/        # >64 MiB 使用并行 Range 下载
blift cp -r datasets:releases ./backup              # 下载文件夹并保持结构
blift dl datasets --all -o ./backup                 # 整个项目
blift rm -r datasets:builds -y
blift share create datasets:releases/v1 --expires 7d
blift share create datasets model.ckpt --password 1234 --expires 7d
blift share get https://files.example.com/s/AbCd123 --password 1234 -o .
wget https://files.example.com/s/XyZ7890/notes.md   # 无需 blift：直接下载链接（未设密码的分享）
blift --json ls datasets | jq '.[].name'
```

## 行为说明

- 上传：先 `init`，服务器决定单次 PUT（≤ 64 MiB）或分片；分片 URL 每批最多 100 个，按 `-j` 并发上传，每片失败重试 3 次（指数退避），最后带 ETag 列表 `complete`。失败或 Ctrl-C 时调用 `DELETE /api/uploads/:id` 取消。
- 下载：先写入 `<目标>.part`，成功后改名；失败时删除临时文件。
- 目录树：先创建文件夹（每个目录一次 `mkdir -p` 请求），再把文件传进去；下载时逐个文件夹列出。空文件夹双向都会保留；
  指向文件的符号链接会被跟随，其他特殊文件跳过。
- 多个文件中个别失败时会继续处理其余文件，最后以非零状态退出。
- 进度条仅在 stderr 为终端且未使用 `-q` 时显示；状态信息写 stderr，表格 / JSON 写 stdout。
