#!/usr/bin/env bash
# Build two backend revisions against identical dependencies, then alternate load.
set -euo pipefail
cd "$(dirname "$0")/.."
baseline_sha="${1:-}"
if [[ "$#" != 1 || ! "$baseline_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Usage: bash benchmarks/compare.sh BASELINE_FULL_COMMIT_SHA' >&2
  exit 1
fi
candidate_sha=$(git rev-parse HEAD)
if [[ "$baseline_sha" == "$candidate_sha" || -n "$(git status --porcelain)" || -f .env ]]; then
  echo 'Comparison requires distinct revisions and a clean isolated worktree without .env.' >&2
  exit 1
fi
if ! git cat-file -e "$baseline_sha^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "$baseline_sha"
fi
# Reusing native bindings or node_modules is valid only with identical inputs.
# Migration changes need a separate protocol; both databases use the same schema.
for dependency in platform/package.json platform/pnpm-lock.yaml platform/shared platform/archestra-rs platform/backend/package.json platform/backend/tsdown.config.ts platform/backend/src/database/migrations; do
  if [[ "$(git rev-parse "$baseline_sha:$dependency")" != "$(git rev-parse "$candidate_sha:$dependency")" ]]; then
    echo "Comparison requires matching dependency/build/schema inputs: $dependency" >&2
    exit 1
  fi
done
[[ -f backend/dist/server.mjs ]] || { echo 'Build the current benchmark first with benchmarks/ci.sh.' >&2; exit 1; }
node --input-type=module - "$candidate_sha" "$(git rev-parse HEAD:platform)" <<'JS'
import fs from 'node:fs';
const report = JSON.parse(fs.readFileSync('benchmarks/results/ci/report.json', 'utf8'));
if (report.complete !== true || report.gitCommit !== process.argv[2] || report.platformTree !== process.argv[3])
  throw Error('Run benchmarks/ci.sh at the current clean revision before comparing builds');
JS
comparison_builds=$(mktemp -d "${TMPDIR:-/tmp}/archestra-proxy-comparison.XXXXXX")
trap 'rm -rf "$comparison_builds"' EXIT
platform_root=$PWD
mkdir -p "$comparison_builds/source" "$comparison_builds/candidate"
cp -R backend/dist/. "$comparison_builds/candidate/"
ln -s "$platform_root/backend/node_modules" "$comparison_builds/candidate/node_modules"
printf '%s\n' "$candidate_sha" > "$comparison_builds/candidate/source-commit.txt"
git -C .. archive "$baseline_sha" platform/backend platform/package.json | tar -x -C "$comparison_builds/source"
baseline_platform="$comparison_builds/source/platform"
ln -s "$platform_root/node_modules" "$baseline_platform/node_modules"
ln -s "$platform_root/backend/node_modules" "$baseline_platform/backend/node_modules"
ln -s "$platform_root/shared" "$baseline_platform/shared"
ln -s "$platform_root/archestra-rs" "$baseline_platform/archestra-rs"
# Never pass deployment credentials or a workflow token into either build.
(
  cd "$baseline_platform/backend"
  env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
    "$platform_root/backend/node_modules/.bin/tsdown"
)
printf '%s\n' "$baseline_sha" > "$baseline_platform/backend/dist/source-commit.txt"
node benchmarks/compare.mjs "$baseline_sha" "$candidate_sha" \
  "$baseline_platform/backend/dist" "$comparison_builds/candidate"
