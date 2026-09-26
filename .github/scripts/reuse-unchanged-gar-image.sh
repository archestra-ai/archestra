#!/usr/bin/env bash
set -euo pipefail

# This is a build optimization, never a source of truth. Missing history,
# registry metadata, or a failed retag falls through to the normal build.
if [[ ! "$SOURCE_VERSION" =~ ^[0-9a-f]{40}$ ]] ||
  [[ ! "$MAX_AGE_DAYS" =~ ^[0-9]+$ ]]; then
  echo "Invalid reuse inputs; building $IMAGE normally."
  exit 0
fi

paths_json=$(jq -ce '
  if type == "array" and length > 0 and all(.[];
    type == "string" and
    test("^(platform|\\.github)/[A-Za-z0-9_./-]+$") and
    (contains("..") | not)
  ) then . else error("invalid image paths") end
' <<< "$REUSE_PATHS" 2>/dev/null) || {
  echo "Invalid image dependency paths; building $IMAGE normally."
  exit 0
}
mapfile -t paths < <(jq -r '.[]' <<< "$paths_json")

if ! git cat-file -e "${SOURCE_VERSION}^{commit}" 2>/dev/null ||
  ! git diff --quiet "$SOURCE_VERSION" HEAD -- \
    "${paths[@]}" \
    .github/workflows/build-native-multi-arch-image.yml \
    .github/actions/build-docker-image \
    .github/actions/setup-docker-builder; then
  echo "Image inputs changed or source commit unavailable; building $IMAGE normally."
  exit 0
fi

source_image="${IMAGE}:${SOURCE_VERSION}"
target_image="${IMAGE}:${VERSION}"

get_digest() {
  docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>/dev/null \
    | jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))'
}

if ! source_digest=$(get_digest "$source_image"); then
  echo "Source image unavailable; building $IMAGE normally."
  exit 0
fi

# Retagging keeps the original digest's upload time. A weekly rebuild picks up
# floating base-image and OS package updates even when repository files are idle.
if ! uploaded=$(gcloud artifacts docker images describe \
  "${IMAGE}@${source_digest}" --format='value(uploadTime)' 2>/dev/null) ||
  ! uploaded_epoch=$(python3 -c '
import datetime, sys
timestamp = datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
assert timestamp.tzinfo is not None
print(int(timestamp.timestamp()))
' "$uploaded" 2>/dev/null); then
  echo "Image upload time unavailable; building $IMAGE normally."
  exit 0
fi
age_seconds=$(($(date -u +%s) - uploaded_epoch))
if ((age_seconds < 0 || age_seconds > MAX_AGE_DAYS * 86400)); then
  echo "Source image is older than ${MAX_AGE_DAYS} days; rebuilding $IMAGE."
  exit 0
fi

if ! gcloud artifacts docker tags add "$source_image" "$target_image" --quiet; then
  echo "Could not retag source image; building $IMAGE normally."
  exit 0
fi
if ! target_digest=$(get_digest "$target_image") ||
  [ "$target_digest" != "$source_digest" ]; then
  echo "Could not verify target digest; building $IMAGE normally."
  exit 0
fi

echo "Reused $IMAGE digest $source_digest for $VERSION."
echo "reused=true" >> "$GITHUB_OUTPUT"
