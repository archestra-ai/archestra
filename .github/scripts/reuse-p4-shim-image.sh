#!/usr/bin/env bash
set -euo pipefail

# An absent previous tag or a registry error is a cache miss: the caller builds
# the image normally. Only a verified destination digest skips that build.
if [[ ! "$PREVIOUS_VERSION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Previous main SHA unavailable; building the p4 image normally."
  exit 0
fi

# The shared build recipe can change the image even when its Docker context does
# not. Treat changes to either as a cache miss.
if ! git diff --quiet "$PREVIOUS_VERSION" HEAD -- \
  platform/p4_shim_docker_image \
  .github/workflows/build-p4-shim-docker-image.yml \
  .github/workflows/build-native-multi-arch-image.yml \
  .github/actions/build-docker-image \
  .github/actions/setup-docker-builder; then
  echo "p4 Docker context or build recipe changed; building the image normally."
  exit 0
fi

source_image="${IMAGE}:${PREVIOUS_VERSION}"
target_image="${IMAGE}:${VERSION}"

get_digest() {
  docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null \
    | jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))'
}

if ! source_digest=$(get_digest "$source_image"); then
  echo "Previous p4 image unavailable; building it normally."
  exit 0
fi

if ! gcloud artifacts docker tags add "$source_image" "$target_image" --quiet; then
  echo "Could not retag the previous p4 image; building it normally."
  exit 0
fi

if ! target_digest=$(get_digest "$target_image"); then
  echo "Could not verify the new p4 tag; building it normally."
  exit 0
fi

if [ "$target_digest" != "$source_digest" ]; then
  echo "The new p4 tag has a different digest; building it normally."
  exit 0
fi

echo "Reused p4 image digest $source_digest for $VERSION."
echo "reused=true" >> "$GITHUB_OUTPUT"
