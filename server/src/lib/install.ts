// The CLI installer served at /install.sh (alias of GET /api/cli/install.sh):
//
//   curl -fsSL https://files.example.com/install.sh | sh
//
// POSIX sh, so `| sh` and `| bash` both work. It installs the CLI release matching this server's
// version, downloaded through this server (GET /api/cli/download relays GitHub Releases, so clients
// that cannot reach GitHub still get it) or else from GitHub directly, checks it against SHA256SUMS
// and prints the login command for this server. The script lives in a template literal: shell `${…}` is written `\${…}` and `\n` as `\\n`;
// test/unit.test.ts runs the rendered script end to end.

export const RELEASE_DOWNLOADS = "https://github.com/davidliyutong/blift/releases/download";

/** Single-quotes a value for sh. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function installScript(server: string, version: string, github = RELEASE_DOWNLOADS): string {
  const shown = server.replace(/[^\x21-\x7e]/g, ""); // for comments: never a line break
  return `#!/bin/sh
# blift CLI installer for ${shown}
#
#   curl -fsSL ${shown}/install.sh | sh
#
# Installs blift v${version} (the version this server runs), downloading it through this server
# (which relays GitHub Releases) or else from GitHub directly, verifies its SHA-256 and prints the
# login command. Optional environment:
#   BLIFT_VERSION       install another release, e.g. BLIFT_VERSION=0.1.0
#   BLIFT_INSTALL_DIR   target directory (default: ~/.local/bin, so no sudo is needed)
#   BLIFT_DOWNLOAD_URL  download only from this mirror of ${github}
set -eu

SERVER=${shq(server)}
SERVER_VERSION=${shq(version)}
GITHUB=${shq(github)}

lang=\${BLIFT_LANG:-\${LC_ALL:-\${LC_MESSAGES:-\${LANG:-}}}}
say() { case $lang in zh* | ZH*) printf '%s\\n' "$2" ;; *) printf '%s\\n' "$1" ;; esac; }
die() { say "error: $1" "错误：$2" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; esac; return 1; }
# Keeps the exit status (bash 3.2 would report the trap's own status).
cleanup() { st=$?; rm -rf "$tmp"; exit "$st"; }

main() {
  version=\${BLIFT_VERSION:-$SERVER_VERSION}
  version=\${version#v}
  if [ -n "\${BLIFT_DOWNLOAD_URL:-}" ]; then
    sources=\${BLIFT_DOWNLOAD_URL%/}
  else
    sources="$SERVER/api/cli/download $GITHUB"
  fi

  case $(uname -s) in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS $(uname -s): blift is built for Linux and macOS" "不支持的系统 $(uname -s)：blift 只提供 Linux 和 macOS 版本" ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported CPU $(uname -m): blift is built for amd64 and arm64" "不支持的 CPU 架构 $(uname -m)：blift 只提供 amd64 和 arm64 版本" ;;
  esac
  # An x86_64 shell under Rosetta on Apple silicon still gets the native build.
  if [ "$os" = darwin ] && [ "$arch" = amd64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
    arch=arm64
  fi

  if has curl; then
    fetch() { curl -fsSL --connect-timeout 10 --retry 2 -o "$2" "$1"; }
  elif has wget; then
    fetch() { wget -q -T 30 -O "$2" "$1"; }
  else
    die "curl or wget is required" "需要 curl 或 wget"
  fi
  if has sha256sum; then
    sha256() { sha256sum "$1"; }
  elif has shasum; then
    sha256() { shasum -a 256 "$1"; }
  else
    die "sha256sum or shasum is required" "需要 sha256sum 或 shasum"
  fi

  name=blift_\${version}_\${os}_\${arch}
  tmp=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  say "Downloading blift v\${version} (\${os}/\${arch})…" "正在下载 blift v\${version}（\${os}/\${arch}）…"
  ok=
  for base in $sources; do
    url=$base/v$version
    if fetch "$url/$name.tar.gz" "$tmp/$name.tar.gz" && fetch "$url/SHA256SUMS" "$tmp/SHA256SUMS"; then
      ok=1
      break
    fi
    say "  not available from $base" "  无法从 $base 下载"
  done
  if [ -z "$ok" ]; then
    die "could not download $name.tar.gz (other release: BLIFT_VERSION=x.y.z, mirror: BLIFT_DOWNLOAD_URL)" \\
      "无法下载 $name.tar.gz（换版本：BLIFT_VERSION=x.y.z；用镜像：BLIFT_DOWNLOAD_URL）"
  fi
  want=$(awk -v f="$name.tar.gz" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  got=$(sha256 "$tmp/$name.tar.gz" | awk '{ print $1 }')
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    die "SHA-256 mismatch for $name.tar.gz" "$name.tar.gz 的 SHA-256 校验失败"
  fi
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"

  # The user's own bin directory, never a global one.
  dir=\${BLIFT_INSTALL_DIR:-$HOME/.local/bin}
  mkdir -p "$dir"
  install -m 755 "$tmp/$name/blift" "$dir/blift"

  installed=$("$dir/blift" version)
  say "✓ $installed → $dir/blift" "✓ $installed → $dir/blift"
  if ! on_path "$dir"; then
    case \${SHELL:-} in
      */zsh) rc=.zshrc ;;
      */bash) if [ "$os" = darwin ]; then rc=.bash_profile; else rc=.bashrc; fi ;;
      */fish) rc= ;;
      *) rc=.profile ;;
    esac
    say "$dir is not on your PATH; add it, then open a new terminal:" "$dir 不在 PATH 中，执行下面的命令加入，然后新开一个终端："
    if [ -z "$rc" ]; then
      printf '  fish_add_path %s\\n' "$dir"
    else
      printf "  echo 'export PATH=\\"%s:\\$PATH\\"' >> ~/%s\\n" "$dir" "$rc"
    fi
  elif [ "$(command -v blift)" != "$dir/blift" ]; then
    say "note: $(command -v blift) comes first on your PATH" "注意：PATH 中优先的是 $(command -v blift)"
  fi
  echo
  say "Sign in to $SERVER:" "登录 \${SERVER}："
  printf '  blift login --server %s\\n' "$SERVER"
}

main "$@"
`;
}
