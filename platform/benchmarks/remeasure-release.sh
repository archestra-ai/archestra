#!/usr/bin/env bash
# Measure an earlier release with its own harness on this runner, so a release
# PR compares with numbers from the same hardware. Run after benchmarks/ci.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
release_sha="${1:-}"
if [[ "$#" -ne 1 || ! "$release_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Usage: bash benchmarks/remeasure-release.sh RELEASE_FULL_COMMIT_SHA' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" || -f .env ]]; then
  echo 'Re-measuring requires a clean isolated worktree without .env.' >&2
  exit 1
fi
if ! git cat-file -e "$release_sha^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "$release_sha"
fi
platform_root=$PWD
release_root=$(mktemp -d "${TMPDIR:-/tmp}/archestra-release-benchmark.XXXXXX")
cleanup() {
  git -C .. worktree remove --force "$release_root/source" 2>/dev/null || true
  rm -rf "$release_root"
}
trap cleanup EXIT
git -C .. worktree add --detach "$release_root/source" "$release_sha" > /dev/null
release_platform="$release_root/source/platform"
mkdir -p benchmarks/results/release
# The release builds with its own dependencies. Cargo reuses this checkout's
# compiled dependencies; no credentials or workflow token reach the build.
status=0
(
  cd "$release_platform"
  env -i PATH="$PATH" HOME="$HOME" CI=true NPM_CONFIG_USERCONFIG=/dev/null \
    pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
  env -i PATH="$PATH" HOME="$HOME" CARGO_TARGET_DIR="$platform_root/archestra-rs/target" \
    bash benchmarks/ci.sh --requests=300 --stream-requests=300 --repeats=2
) > benchmarks/results/release/run.log 2>&1 || status=$?
cp "$release_platform"/benchmarks/results/*.log benchmarks/results/release/ 2>/dev/null || true
if [[ -f "$release_platform/benchmarks/results/ci/report.json" ]]; then
  cp "$release_platform/benchmarks/results/ci/report.json" "$release_platform/benchmarks/results/ci/summary.md" \
    benchmarks/results/release/
fi
if [[ "$status" != 0 ]]; then
  tail -40 benchmarks/results/release/run.log >&2
  exit "$status"
fi
