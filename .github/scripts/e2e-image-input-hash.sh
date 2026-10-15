#!/usr/bin/env bash
# Content-addressed identity of an E2E image build: the Docker context plus
# the workflow/action files that define how the image is produced. A later
# run with the same hash can reuse the published image instead of rebuilding.
set -euo pipefail

kind="${1:-}"

workflow_blob="$(git rev-parse HEAD:.github/workflows/platform-e2e-tests.yml)"
build_action_blob="$(git rev-parse HEAD:.github/actions/build-docker-image/action.yml)"
builder_action_blob="$(git rev-parse HEAD:.github/actions/setup-docker-builder/action.yml)"
hash_script_blob="$(git rev-parse HEAD:.github/scripts/e2e-image-input-hash.sh)"

definition() {
  printf 'workflow %s\n' "$workflow_blob"
  printf 'build-action %s\n' "$build_action_blob"
  printf 'builder-action %s\n' "$builder_action_blob"
  printf 'hash-script %s\n' "$hash_script_blob"
}

case "$kind" in
  platform)
    {
      printf 'context\n'
      # Hash leaf entries so Docker-excluded test changes do not invalidate
      # the runtime image. Only omit patterns we can prove are excluded: any
      # negation or Dockerfile-specific ignore file disables this optimization.
      # The ignore file itself remains an input. All other files stay in the
      # hash, including files we could theoretically also exclude.
      python3 - <<'PY'
import subprocess
import sys

def git(*args):
    return subprocess.check_output(["git", *args])

patterns = git("show", "HEAD:platform/.dockerignore").decode().splitlines()
has_override = subprocess.run(
    ["git", "cat-file", "-e", "HEAD:platform/Dockerfile.dockerignore"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
).returncode == 0
can_exclude = not has_override and not any(p.lstrip().startswith("!") for p in patterns)
for entry in git("ls-tree", "-rz", "HEAD:platform").split(b"\0"):
    if not entry:
        continue
    _, path = entry.split(b"\t", 1)
    excluded = (
        ("e2e-tests" in patterns and path.startswith(b"e2e-tests/"))
        or ("docs-screenshots" in patterns and path.startswith(b"docs-screenshots/"))
        or ("**/*.test.ts" in patterns and path.endswith(b".test.ts"))
        or ("**/*.test.tsx" in patterns and path.endswith(b".test.tsx"))
    )
    if not (can_exclude and excluded):
        sys.stdout.buffer.write(entry + b"\0")
PY
      definition
    } | git hash-object --stdin
    ;;
  mcp-base)
    {
      printf 'context %s\n' "$(git rev-parse HEAD:platform/mcp_server_docker_image)"
      definition
    } | git hash-object --stdin
    ;;
  *)
    echo "usage: $0 platform|mcp-base" >&2
    exit 1
    ;;
esac
