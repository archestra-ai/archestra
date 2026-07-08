#!/bin/sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
dockerfile="$root_dir/Dockerfile"
cargo_toml="$root_dir/archestra-rs/sandbox-core/Cargo.toml"
# The engine image the backend provisions. The Helm chart no longer deploys an
# engine, so this constant is the only thing pinning the engine version.
manager_ts="$root_dir/backend/src/k8s/dagger-environment-runtime/manager.ts"
bench_dagger_compose="$root_dir/../ai-labs/dev/docker-compose.bench-dagger.yml"

docker_version="$(sed -n 's/^ARG DAGGER_VERSION=v\{0,1\}\([0-9][^[:space:]]*\)$/\1/p' "$dockerfile")"
cargo_version="$(sed -n 's/^dagger-sdk = "=\([0-9][^"]*\)"$/\1/p' "$cargo_toml")"
engine_image_version="$(sed -n 's#^const ENGINE_IMAGE = "registry.dagger.io/engine:v\([0-9][^"]*\)";$#\1#p' "$manager_ts")"
bench_dagger_version="$(sed -n 's#^[[:space:]]*image:[[:space:]]*registry.dagger.io/engine:v\{0,1\}\([0-9][^"[:space:]]*\)[[:space:]]*$#\1#p' "$bench_dagger_compose")"

case "$docker_version:$cargo_version:$engine_image_version:$bench_dagger_version" in
  *::* | :* | *:)
    echo "failed to read Dagger versions from Dockerfile, archestra-rs/sandbox-core/Cargo.toml, backend/src/k8s/dagger-environment-runtime/manager.ts, and ai-labs/dev/docker-compose.bench-dagger.yml" >&2
    exit 1
    ;;
  "$cargo_version:$cargo_version:$cargo_version:$cargo_version")
    exit 0
    ;;
  *)
    echo "Dagger version mismatch: Dockerfile has $docker_version, dagger-sdk has $cargo_version, manager.ts ENGINE_IMAGE has $engine_image_version, bench-dagger compose has $bench_dagger_version" >&2
    exit 1
    ;;
esac
