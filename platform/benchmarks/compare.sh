#!/usr/bin/env bash
# Build pinned revisions with their own dependencies, then alternate load.
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
# Native bindings and schema are shared only when their source inputs match.
# JavaScript dependencies are installed separately so patches remain attributable.
for dependency in platform/package.json platform/shared platform/archestra-rs platform/backend/package.json platform/backend/tsdown.config.ts platform/backend/src/database/migrations; do
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
git -C .. archive "$baseline_sha" platform/backend platform/shared platform/archestra-rs \
  platform/package.json platform/pnpm-lock.yaml platform/pnpm-workspace.yaml platform/patches | tar -x -C "$comparison_builds/source"
baseline_platform="$comparison_builds/source/platform"
# Rust source/build inputs match above. Reuse only generated bindings; every
# package keeps its own node_modules, including patched transitive dependencies.
node --input-type=module - "$platform_root" "$baseline_platform" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [source, target] = process.argv.slice(2);
for (const crate of fs.readdirSync(path.join(source, 'archestra-rs'), {withFileTypes:true})) {
  if (!crate.isDirectory() || !fs.existsSync(path.join(target, 'archestra-rs', crate.name, 'package.json'))) continue;
  for (const file of fs.readdirSync(path.join(source, 'archestra-rs', crate.name))) {
    if (file.endsWith('.node') || ['index.js', 'index.d.ts'].includes(file))
      fs.copyFileSync(path.join(source, 'archestra-rs', crate.name, file), path.join(target, 'archestra-rs', crate.name, file));
  }
}
JS
(
  cd "$baseline_platform"
  env -i PATH="$PATH" HOME="$HOME" CI=true NPM_CONFIG_USERCONFIG=/dev/null \
    pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --filter @backend...
)
# Never pass deployment credentials or a workflow token into either build.
(
  cd "$baseline_platform/backend"
  env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
    "$baseline_platform/backend/node_modules/.bin/tsdown"
)
printf '%s\n' "$baseline_sha" > "$baseline_platform/backend/dist/source-commit.txt"
node --input-type=module - "$baseline_sha" "$baseline_platform/backend/dist" "$candidate_sha" "$comparison_builds/candidate" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
for (const [commit, dist] of [[process.argv[2],process.argv[3]],[process.argv[4],process.argv[5]]]) {
  const inputs = Object.fromEntries(['pnpm-lock.yaml','pnpm-workspace.yaml','patches'].map(file => [file, execFileSync('git',['rev-parse',`${commit}:platform/${file}`],{encoding:'utf8'}).trim()]));
  fs.writeFileSync(path.join(dist,'dependency-inputs.json'),JSON.stringify(inputs));
}
JS
node benchmarks/compare.mjs "$baseline_sha" "$candidate_sha" \
  "$baseline_platform/backend/dist" "$comparison_builds/candidate"
