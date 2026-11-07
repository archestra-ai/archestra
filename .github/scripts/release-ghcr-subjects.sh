#!/usr/bin/env bash
# Turns the release run's staged image references (one file per image, named
# after it, holding ghcr.io/archestra-ai/ci/<image>@sha256:<digest>) into:
#   release-ghcr-subjects.txt  attestation subjects under the public names
#   release-ghcr-images.json   {"<image>": "sha256:<digest>"} for the publisher
# Docker Hub references (the platform image) are published elsewhere.
set -euo pipefail

directory=$1
subjects=release-ghcr-subjects.txt
images=release-ghcr-images.json
: > "$subjects"
echo '{}' > "$images"
shopt -s nullglob
for file in "$directory"/*; do
  name=${file##*/}
  reference=$(<"$file")
  [[ "$reference" == docker.io/* ]] && continue
  [[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "::error::Unexpected image name: $name"; exit 1; }
  # The file name must match the staged repository, so no file carries
  # another image's digest under its name.
  [[ "$reference" =~ ^ghcr\.io/archestra-ai/ci/${name}@sha256:([0-9a-f]{64})$ ]] \
    || { echo "::error::Unexpected staged reference for $name"; exit 1; }
  digest=${BASH_REMATCH[1]}
  printf '%s  ghcr.io/archestra-ai/%s\n' "$digest" "$name" >> "$subjects"
  jq --arg name "$name" --arg digest "sha256:$digest" '.[$name] = $digest' "$images" > "$images.tmp"
  mv "$images.tmp" "$images"
done
# mcp-server-base ships with every release; its absence means a missing build.
jq -e 'has("mcp-server-base")' "$images" > /dev/null \
  || { echo "::error::Missing the mcp-server-base release image"; exit 1; }
cat "$subjects"
