#!/usr/bin/env bash
set -euo pipefail

BOOTSTRAP_FAILED_MARKER=""

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
dagger_os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    MINGW* | MSYS* | CYGWIN*) echo windows ;;
    *) echo unsupported ;;
  esac
}
# best-effort: never abort bootstrap on failure — deps are the critical output.
ensure_dagger_cli() {
  local bin root version os arch tmp
  os="$(dagger_os)"
  if [ "$os" != darwin ] && [ "$os" != linux ]; then
    echo "Skipping Dagger CLI bootstrap on $(uname -s); set ARCHESTRA_DAGGER_RUNTIME_CLI_BIN manually if the code runtime is needed" >&2
    return 0
  fi
  bin="$(main_repo_root)/.dev-bin/dagger"
  root="$(repo_root)"
  version="$(sed -n 's/^ARG DAGGER_VERSION=v\{0,1\}\([0-9][^[:space:]]*\)$/\1/p' "$root/platform/Dockerfile")"
  if [ -z "$version" ]; then
    echo "could not read DAGGER_VERSION from platform/Dockerfile" >&2
    return 1
  fi
  if [ -x "$bin" ] && "$bin" version 2>/dev/null | grep -q "v${version}"; then
    return 0
  fi
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch=amd64 ;;
    aarch64) arch=arm64 ;;
  esac
  mkdir -p "$(dirname "$bin")"
  echo "Bootstrapping Dagger CLI v${version} for ${os}/${arch} into ${bin}" >&2
  # extract to a temp file and atomically rename so concurrent worktree adds
  # can't interleave writes into the shared binary.
  tmp="$(dirname "$bin")/.dagger.download.$$"
  if ! curl -fsSL "https://dl.dagger.io/dagger/releases/${version}/dagger_v${version}_${os}_${arch}.tar.gz" \
    | tar -xzO dagger >"$tmp"; then
    rm -f "$tmp"
    echo "failed to download Dagger CLI v${version}" >&2
    return 1
  fi
  chmod +x "$tmp" || { rm -f "$tmp"; echo "failed to prepare Dagger CLI v${version}" >&2; return 1; }
  mv -f "$tmp" "$bin" || { rm -f "$tmp"; echo "failed to install Dagger CLI v${version}" >&2; return 1; }
}
bootstrap() {
  local root
  root="$(repo_root)"
  # the hook runs this detached, so any failure is otherwise only visible in the
  # log. Drop a sentinel on failure (removed on success) that a session can detect
  # instead of silently working against half-installed deps.
  BOOTSTRAP_FAILED_MARKER="$root/.worktree-bootstrap.failed"
  rm -f "$BOOTSTRAP_FAILED_MARKER"
  trap 'rc=$?; if [ "$rc" -ne 0 ] && [ -n "$BOOTSTRAP_FAILED_MARKER" ]; then printf "%s\n" "worktree bootstrap failed (exit $rc) — see .worktree-bootstrap.log" >"$BOOTSTRAP_FAILED_MARKER"; fi' EXIT
  if [ ! -f "$root/platform/pnpm-lock.yaml" ]; then
    echo "ERROR: no platform/pnpm-lock.yaml under $root" >&2
    exit 1
  fi
  CI=true pnpm --dir "$root/platform" install --frozen-lockfile --prefer-offline
  ensure_dagger_cli || echo "WARNING: Dagger CLI bootstrap failed; deps are installed. Re-run: pnpm worktree:bootstrap" >&2
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
log="$worktree_root/.worktree-bootstrap.log"
# run detached (stdio redirected to the log, stdin from /dev/null) so
# `git worktree add` returns immediately instead of blocking on a full pnpm
# install. Fall back to a synchronous run if nohup is unavailable, so bootstrap
# still happens rather than falsely reporting a background launch.
if command -v nohup >/dev/null 2>&1; then
  nohup "$bootstrap" bootstrap >"$log" 2>&1 </dev/null &
  echo "Archestra worktree bootstrap started in background (log: $log; on failure: $worktree_root/.worktree-bootstrap.failed)" >&2
else
  "$bootstrap" bootstrap >"$log" 2>&1 </dev/null \
    || echo "Archestra worktree bootstrap failed — see $log" >&2
fi
exit 0
EOF
  chmod +x "$hook"
  echo "Installed Archestra worktree bootstrap hook: $hook" >&2
}
case "${1:-bootstrap}" in
  bootstrap) bootstrap ;;
  install-hook) install_hook ;;
  *)
    echo "Usage: $0 [bootstrap|install-hook]" >&2
    exit 1
    ;;
esac
