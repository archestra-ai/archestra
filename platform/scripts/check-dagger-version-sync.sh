#!/bin/sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
dockerfile="$root_dir/Dockerfile"
cargo_toml="$root_dir/archestra-rs/sandbox-core/Cargo.toml"

docker_version="$(sed -n 's/^ARG DAGGER_VERSION=v\{0,1\}\([0-9][^[:space:]]*\)$/\1/p' "$dockerfile")"
cargo_version="$(sed -n 's/^dagger-sdk = "=\([0-9][^"]*\)"$/\1/p' "$cargo_toml")"

case "$docker_version:$cargo_version" in
  :* | *:)
    echo "failed to read Dagger versions from Dockerfile and archestra-rs/sandbox-core/Cargo.toml" >&2
    exit 1
    ;;
  "$cargo_version:$cargo_version")
    exit 0
    ;;
  *)
    echo "Dagger version mismatch: Dockerfile has $docker_version, dagger-sdk has $cargo_version" >&2
    exit 1
    ;;
esac
