#!/bin/sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
dockerfile="$root_dir/Dockerfile"
cargo_toml="$root_dir/archestra-rs/sandbox-core/Cargo.toml"
# The engine image the backend provisions. The Helm chart no longer deploys an
# engine, so this constant is the only thing pinning the engine version.
manager_ts="$root_dir/backend/src/k8s/dagger-environment-runtime/manager.ts"
# The quickstart image ships a rendered engine manifest rather than a chart, so
# its image tag has to be checked here or it silently drifts.
quickstart_manifest="$root_dir/docker/dagger-engine.quickstart.yaml"
bench_dagger_compose="$root_dir/../ai-labs/dev/docker-compose.bench-dagger.yml"

# Image refs must carry the `v` prefix: registry.dagger.io publishes `v0.21.5`,
# not `0.21.5`. Accepting a bare tag here would let a ref that pulls nothing pass
# this check. The Dockerfile's DAGGER_VERSION is a version string rather than a
# tag, so it stays tolerant of the prefix.
engine_image_tag() {
  sed -n 's#^[[:space:]]*image:[[:space:]]*registry.dagger.io/engine:v\([0-9][^"[:space:]]*\)[[:space:]]*$#\1#p' "$1"
}

docker_version="$(sed -n 's/^ARG DAGGER_VERSION=v\{0,1\}\([0-9][^[:space:]]*\)$/\1/p' "$dockerfile")"
cargo_version="$(sed -n 's/^dagger-sdk = "=\([0-9][^"]*\)"$/\1/p' "$cargo_toml")"
# tolerate reformatting around the constant (indentation, spacing, a trailing
# comment); only the image tag itself is pinned.
engine_image_version="$(sed -n 's#^[[:space:]]*const[[:space:]][[:space:]]*ENGINE_IMAGE[[:space:]]*=[[:space:]]*"registry.dagger.io/engine:v\([0-9][^"]*\)".*#\1#p' "$manager_ts")"
quickstart_version="$(engine_image_tag "$quickstart_manifest")"
bench_dagger_version="$(engine_image_tag "$bench_dagger_compose")"

case "$docker_version:$cargo_version:$engine_image_version:$quickstart_version:$bench_dagger_version" in
  *::* | :* | *:)
    echo "failed to read Dagger versions from Dockerfile, archestra-rs/sandbox-core/Cargo.toml, backend/src/k8s/dagger-environment-runtime/manager.ts, docker/dagger-engine.quickstart.yaml, and ai-labs/dev/docker-compose.bench-dagger.yml" >&2
    exit 1
    ;;
  "$cargo_version:$cargo_version:$cargo_version:$cargo_version:$cargo_version")
    exit 0
    ;;
  *)
    echo "Dagger version mismatch: Dockerfile has $docker_version, dagger-sdk has $cargo_version, manager.ts ENGINE_IMAGE has $engine_image_version, quickstart manifest has $quickstart_version, bench-dagger compose has $bench_dagger_version" >&2
    exit 1
    ;;
esac
