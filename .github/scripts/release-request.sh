#!/usr/bin/env bash
# Writes the release-publisher request that publish-release-images sends
# (archestra-ai/.github release-publish.yml) to GITHUB_OUTPUT:
#   images  the attested digests, {"<public name>": "sha256:<digest>"}, as one line
#   latest  the :latest channels to move: stable for the newest stable line,
#           newest for the platform's newest release, release candidates included
# Inputs: VERSION, PRESERVE_LATEST, PLATFORM_LATEST, GITHUB_OUTPUT.
set -euo pipefail

images_file=$1
images=$(jq -ce 'if type == "object" and length > 0 then . else error("no images") end' "$images_file")
latest=
if [[ "$VERSION" != *-* && "$PRESERVE_LATEST" == false ]]; then
  latest=stable
fi
if [ "${PLATFORM_LATEST:-false}" = true ]; then
  latest="${latest:+$latest }newest"
fi
{
  echo "images=$images"
  echo "latest=$latest"
} >> "$GITHUB_OUTPUT"
