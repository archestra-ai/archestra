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
      git ls-tree "HEAD:platform" | grep -v $'\te2e-tests$' || true
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
