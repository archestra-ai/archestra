#!/bin/sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
dockerfile="$root_dir/Dockerfile"
cargo_toml="$root_dir/archestra-rs/sandbox-core/Cargo.toml"
# The upstream engine the backend falls back to when no release digest pins
# Archestra's patched build (dev, CI e2e, the quickstart).
config_ts="$root_dir/backend/src/config.ts"
# The quickstart image ships a rendered engine manifest rather than a chart, so
# its image tag has to be checked here or it silently drifts.
quickstart_manifest="$root_dir/docker/dagger-engine.quickstart.yaml"
bench_dagger_compose="$root_dir/../ai-labs/dev/docker-compose.bench-dagger.yml"
bench_dagger_job="$root_dir/../.github/bench/dagger-job.yaml"

# Image refs must carry the `v` prefix: registry.dagger.io publishes `v0.21.5`,
# not `0.21.5`. Accepting a bare tag here would let a ref that pulls nothing pass
# this check. The Dockerfile's DAGGER_VERSION is a version string rather than a
# tag, so it stays tolerant of the prefix.
engine_image_tag() {
  sed -n 's#^[[:space:]]*image:[[:space:]]*registry.dagger.io/engine:v\([0-9][^"@[:space:]]*\)\(@sha256:[0-9a-f]\{64\}\)\{0,1\}[[:space:]]*$#\1#p' "$1"
}

engine_image_digest() {
  sed -n 's#^[[:space:]]*image:[^@]*@\(sha256:[0-9a-f]\{64\}\)[[:space:]]*$#\1#p' "$1"
}

docker_version="$(sed -n 's/^ARG DAGGER_VERSION=v\{0,1\}\([0-9][^[:space:]]*\)$/\1/p' "$dockerfile")"
cargo_version="$(sed -n 's/^dagger-sdk = "=\([0-9][^"]*\)"$/\1/p' "$cargo_toml")"
# tolerate reformatting around the constant (indentation, spacing, a trailing
# comment); only the image tag itself is pinned.
engine_image_version="$(sed -n 's#^[[:space:]]*: "registry.dagger.io/engine:v\([0-9][^"@]*\)");$#\1#p' "$config_ts")"
# The upstream image the patched dagger-engine target of the Dockerfile starts
# from: same version, pinned to the same digest as the benchmark Job.
engine_base_version="$(sed -n 's#^ARG DAGGER_ENGINE_BASE_IMAGE=registry.dagger.io/engine:v\([0-9][^@]*\)@sha256:[0-9a-f]\{64\}$#\1#p' "$dockerfile")"
engine_base_digest="$(sed -n 's#^ARG DAGGER_ENGINE_BASE_IMAGE=[^@]*@\(sha256:[0-9a-f]\{64\}\)$#\1#p' "$dockerfile")"
quickstart_version="$(engine_image_tag "$quickstart_manifest")"
bench_dagger_version="$(engine_image_tag "$bench_dagger_compose")"
bench_dagger_job_version="$(engine_image_tag "$bench_dagger_job")"
bench_dagger_job_digest="$(engine_image_digest "$bench_dagger_job")"

if [ -z "$bench_dagger_job_digest" ]; then
  echo "the privileged benchmark Dagger image must be pinned by sha256 digest" >&2
  exit 1
fi

if [ "$engine_base_digest" != "$bench_dagger_job_digest" ]; then
  echo "the Dockerfile's DAGGER_ENGINE_BASE_IMAGE digest ($engine_base_digest) differs from the benchmark Job's ($bench_dagger_job_digest)" >&2
  exit 1
fi

case "$docker_version:$cargo_version:$engine_image_version:$engine_base_version:$quickstart_version:$bench_dagger_version:$bench_dagger_job_version" in
  *::* | :* | *:)
    echo "failed to read one or more pinned Dagger versions" >&2
    exit 1
    ;;
  "$cargo_version:$cargo_version:$cargo_version:$cargo_version:$cargo_version:$cargo_version:$cargo_version")
    exit 0
    ;;
  *)
    echo "Dagger version mismatch: Dockerfile has $docker_version, dagger-sdk has $cargo_version, config.ts upstream engine has $engine_image_version, Dockerfile DAGGER_ENGINE_BASE_IMAGE has $engine_base_version, quickstart manifest has $quickstart_version, bench-dagger compose has $bench_dagger_version, benchmark Job has $bench_dagger_job_version" >&2
    exit 1
    ;;
esac
