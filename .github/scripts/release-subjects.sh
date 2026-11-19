#!/usr/bin/env bash
# Turns the release run's staged image references (one file per image, named
# after it, holding ghcr.io/archestra-ai/ci/<image>@sha256:<digest>) and the
# release chart into:
#   release-subjects.txt  attestation subjects, each under its public name
#   release-images.json   {"<public name>": "sha256:<digest>"} for the publisher
#   release-pins.json     {"<image>": "sha256:<digest>"} for the chart to pin
# The platform's public name is docker.io/archestra/platform; every other
# image's is <companion registry>/<image>. The chart is attested by file name.
#
# Usage: release-subjects.sh <staged references dir> <companion registry> [chart.tgz]
set -euo pipefail

directory=$1
companion_registry=$2
chart=${3:-}
case "$companion_registry" in
  ghcr.io/archestra-ai | europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public) ;;
  *) echo "::error::Unexpected companion registry: $companion_registry"; exit 1 ;;
esac
subjects=release-subjects.txt
images=release-images.json
pins=release-pins.json
: > "$subjects"
echo '{}' > "$images"
echo '{}' > "$pins"
shopt -s nullglob
for file in "$directory"/*; do
  name=${file##*/}
  reference=$(<"$file")
  [[ "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { echo "::error::Unexpected image name: $name"; exit 1; }
  # The file name must match the staged repository, so no file carries
  # another image's digest under its name.
  [[ "$reference" =~ ^ghcr\.io/archestra-ai/ci/${name}@sha256:([0-9a-f]{64})$ ]] \
    || { echo "::error::Unexpected staged reference for $name"; exit 1; }
  digest=${BASH_REMATCH[1]}
  destination="$companion_registry/$name"
  [ "$name" = platform ] && destination=docker.io/archestra/platform
  printf '%s  %s\n' "$digest" "$destination" >> "$subjects"
  jq --arg key "$destination" --arg digest "sha256:$digest" '.[$key] = $digest' "$images" > "$images.tmp"
  mv "$images.tmp" "$images"
  jq --arg key "$name" --arg digest "sha256:$digest" '.[$key] = $digest' "$pins" > "$pins.tmp"
  mv "$pins.tmp" "$pins"
done
# Both ship with every release; an absence means a missing build.
for required in platform mcp-server-base; do
  jq -e --arg name "$required" 'has($name)' "$pins" > /dev/null \
    || { echo "::error::Missing the $required release image"; exit 1; }
done
if [ -n "$chart" ]; then
  [[ "${chart##*/}" =~ ^archestra-platform-[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?\.tgz$ ]] \
    || { echo "::error::Unexpected chart file: $chart"; exit 1; }
  printf '%s  %s\n' "$(sha256sum "$chart" | cut -d' ' -f1)" "${chart##*/}" >> "$subjects"
fi
cat "$subjects"
