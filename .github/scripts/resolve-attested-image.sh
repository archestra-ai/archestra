#!/usr/bin/env bash

set -euo pipefail

image_tag=${1:?image tag is required}
# Current full and slim images each contain 1,726 packages. Keep a wide margin
# for legitimate removals while rejecting empty or materially truncated SBOMs.
minimum_packages=${2:-1000}
image_repo=${image_tag%:*}
registry_host=${image_repo%%/*}
registry_path=${image_repo#*/}

index_file=$(mktemp)
docker buildx imagetools inspect "$image_tag" --raw >"$index_file"
image_digest="sha256:$(sha256sum "$index_file")"
image_digest=${image_digest%% *}
image_ref="${image_repo}@${image_digest}"
index_json=$(<"$index_file")
rm -f "$index_file"
access_token=$(gcloud auth print-access-token 2>/dev/null || true)

mapfile -t platform_digests < <(
  jq -r '
    .manifests[]
    | select(.annotations["vnd.docker.reference.type"] != "attestation-manifest")
    | select(.platform.os != "unknown" and .platform.architecture != "unknown")
    | .digest
  ' <<<"$index_json"
)

if [ "${#platform_digests[@]}" -ne 1 ]; then
  echo "Expected exactly one runnable platform manifest in ${image_ref}; found ${#platform_digests[@]}. Add per-platform scan inputs before publishing a multi-platform E2E image." >&2
  exit 1
fi

for platform_digest in "${platform_digests[@]}"; do
  if [[ ! "$platform_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Invalid platform digest in ${image_ref}: ${platform_digest}" >&2
    exit 1
  fi
  mapfile -t attestation_digests < <(
    jq -r --arg digest "$platform_digest" '
      .manifests[]
      | select(.annotations["vnd.docker.reference.type"] == "attestation-manifest")
      | select(.annotations["vnd.docker.reference.digest"] == $digest)
      | .digest
    ' <<<"$index_json"
  )
  if [ "${#attestation_digests[@]}" -ne 1 ]; then
    echo "Expected exactly one attestation manifest for ${platform_digest}; found ${#attestation_digests[@]}." >&2
    exit 1
  fi
  if [[ ! "${attestation_digests[0]}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Invalid attestation digest for ${platform_digest}: ${attestation_digests[0]}" >&2
    exit 1
  fi

  attestation_manifest=$(
    docker buildx imagetools inspect \
      "${image_repo}@${attestation_digests[0]}" \
      --raw
  )
  mapfile -t sbom_blobs < <(
    jq -r '
      .layers[]
      | select(.annotations["in-toto.io/predicate-type"] == "https://spdx.dev/Document")
      | .digest
    ' <<<"$attestation_manifest"
  )
  if [ "${#sbom_blobs[@]}" -ne 1 ]; then
    echo "Expected exactly one SPDX attestation for ${platform_digest}; found ${#sbom_blobs[@]}." >&2
    exit 1
  fi
  if [[ ! "${sbom_blobs[0]}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Invalid SBOM blob digest for ${platform_digest}: ${sbom_blobs[0]}" >&2
    exit 1
  fi

  curl_args=(--fail --silent --show-error --location --retry 3 --retry-all-errors)
  if [ -n "$access_token" ]; then
    curl_args+=(--header "Authorization: Bearer ${access_token}")
  fi
  sbom_file=$(mktemp)
  curl "${curl_args[@]}" \
    --output "$sbom_file" \
    "https://${registry_host}/v2/${registry_path}/blobs/${sbom_blobs[0]}"
  if ! printf '%s  %s\n' "${sbom_blobs[0]#sha256:}" "$sbom_file" | sha256sum -c - >/dev/null; then
    echo "SBOM blob digest mismatch for ${platform_digest}." >&2
    rm -f "$sbom_file"
    exit 1
  fi

  if ! jq -e \
    --arg digest "${platform_digest#sha256:}" \
    --argjson minimum "$minimum_packages" '
      .predicateType == "https://spdx.dev/Document"
      and any(.subject[]?; .digest.sha256 == $digest)
      and (.predicate.spdxVersion | startswith("SPDX-"))
      and ((.predicate.packages | length) >= $minimum)
    ' "$sbom_file" >/dev/null; then
    echo "SBOM for ${platform_digest} is unbound, malformed, or has fewer than ${minimum_packages} packages." >&2
    rm -f "$sbom_file"
    exit 1
  fi
  package_count=$(jq -r '.predicate.packages | length' "$sbom_file")
  rm -f "$sbom_file"
  echo "Validated ${package_count} packages for ${platform_digest}." >&2
done

printf '%s\n' "$image_ref"
