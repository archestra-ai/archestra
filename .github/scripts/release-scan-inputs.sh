#!/usr/bin/env bash
# Resolve the complete, same-revision set of per-arch digests produced by this
# workflow run. Scan these immutable references before creating a version tag.
set -euo pipefail

digest_dir=${1:?digest directory required}
: "${IMAGE:?image repository required}"
: "${AMD64_ONLY:?architecture policy required}"
source_sha=$(git rev-parse HEAD)
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]
expected=2
case "$AMD64_ONLY" in
  true) expected=1 ;;
  false) ;;
  *) echo 'Invalid architecture policy' >&2; exit 1 ;;
esac
shopt -s nullglob
digest_files=("$digest_dir"/*)
[ "${#digest_files[@]}" -eq "$expected" ] || { echo 'Incomplete release digest set' >&2; exit 1; }
amd64=
arm64=
for file in "${digest_files[@]}"; do
  digest=${file##*/}
  [[ -f "$file" && ! -L "$file" && "$digest" =~ ^[0-9a-f]{64}$ ]]
  [ "$(cat "$file")" = "$source_sha" ] || { echo 'Release digest revision mismatch' >&2; exit 1; }
  reference="${IMAGE}@sha256:${digest}"
  index=$(docker buildx imagetools inspect "$reference" --raw)
  # Buildx emits a single-platform index with optional attestation manifests.
  # Reject missing, duplicate, unknown, or unexpected runnable architectures.
  platform=$(jq -er '
    [.manifests[] | select(.annotations["vnd.docker.reference.type"] != "attestation-manifest")]
    | select(length == 1) | .[0].platform | select(.os == "linux") | .architecture
  ' <<< "$index")
  case "$platform" in
    amd64) [ -z "$amd64" ]; amd64="registry://${reference}" ;;
    arm64) [ "$AMD64_ONLY" = false ]; [ -z "$arm64" ]; arm64="registry://${reference}" ;;
    *) echo "Unexpected release architecture: $platform" >&2; exit 1 ;;
  esac
  echo "Release ${source_sha} (${platform}): ${reference}" >> "$GITHUB_STEP_SUMMARY"
done
[ -n "$amd64" ]
if [ "$AMD64_ONLY" = false ]; then [ -n "$arm64" ]; fi
{
  echo "amd64=$amd64"
  echo "arm64=$arm64"
} >> "$GITHUB_OUTPUT"
