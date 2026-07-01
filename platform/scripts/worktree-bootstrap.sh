#!/usr/bin/env bash
set -euo pipefail

repo_root() {
  local script_dir
  script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  git -C "$script_dir/../.." rev-parse --show-toplevel
}
main_repo_root() {
  local root common_git_dir
  root="$(repo_root)"
  common_git_dir="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)"
  dirname "$common_git_dir"
}
ensure_dagger_cli() {
  local bin root version os arch
  bin="$(main_repo_root)/.dev-bin/dagger"
  root="$(repo_root)"
  version="$(sed -n 's/^ARG DAGGER_VERSION=v\{0,1\}\([0-9][^[:space:]]*\)$/\1/p' "$root/platform/Dockerfile")"
  if [ -z "$version" ]; then
    echo "ERROR: failed to read DAGGER_VERSION from platform/Dockerfile" >&2
    exit 1
  fi
  if [ -x "$bin" ] && "$bin" version 2>/dev/null | grep -q "v${version}"; then
    return 0
  fi
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch=amd64 ;;
    aarch64) arch=arm64 ;;
  esac
  mkdir -p "$(dirname "$bin")"
  echo "Bootstrapping Dagger CLI v${version} for ${os}/${arch} into ${bin}" >&2
  curl -fsSL "https://dl.dagger.io/dagger/releases/${version}/dagger_v${version}_${os}_${arch}.tar.gz" \
    | tar -xz -C "$(dirname "$bin")" dagger
  chmod +x "$bin"
}
bootstrap() {
  local root store_dir
  root="$(repo_root)"
  store_dir="$(main_repo_root)/.pnpm-store"
  if [ ! -f "$root/platform/pnpm-lock.yaml" ]; then
    echo "ERROR: no platform/pnpm-lock.yaml under $root" >&2
    exit 1
  fi
  CI=true pnpm --dir "$root/platform" install --frozen-lockfile --prefer-offline --store-dir "$store_dir"
  ensure_dagger_cli
}
install_hook() {
  local root common_git_dir hook_dir hook marker
  root="$(repo_root)"
  common_git_dir="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)"
  hook_dir="$common_git_dir/hooks"
  hook="$hook_dir/post-checkout"
  marker="archestra-worktree-bootstrap"
  if [ -e "$hook" ] && ! grep -q "$marker" "$hook"; then
    echo "ERROR: refusing to overwrite existing unmanaged hook: $hook" >&2
    exit 1
  fi
  mkdir -p "$hook_dir"
  cat >"$hook" <<'EOF'
#!/bin/sh
# archestra-worktree-bootstrap
set -u
case "${1:-}" in
  0000000000000000000000000000000000000000) ;;
  *) exit 0 ;;
esac
worktree_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
bootstrap="$worktree_root/platform/scripts/worktree-bootstrap.sh"
[ -x "$bootstrap" ] || exit 0
"$bootstrap" bootstrap || {
  status=$?
  echo "WARNING: Archestra worktree bootstrap failed with exit $status. Run manually: $bootstrap bootstrap" >&2
}
exit 0
EOF
  chmod +x "$hook"
  echo "Installed Archestra worktree bootstrap hook: $hook" >&2
}
case "${1:-bootstrap}" in
  bootstrap) bootstrap ;;
  install-hook) install_hook ;;
  *) echo "Usage: $0 [bootstrap|install-hook]" >&2; exit 1 ;;
esac
