#!/bin/sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
dockerfile="$root_dir/Dockerfile"
cargo_toml="$root_dir/archestra-rs/sandbox-core/Cargo.toml"
archestra_chart="$root_dir/helm/archestra/Chart.yaml"
dagger_runtime_chart="$root_dir/helm/dagger-runtime/Chart.yaml"
bench_dagger_compose="$root_dir/../ai-labs/dev/docker-compose.bench-dagger.yml"

# extract the dagger-helm dependency version from a Chart.yaml, tolerant of
# field order and indentation within the dependency block.
dagger_helm_chart_version() {
  awk '
    /^[[:space:]]*- name: dagger-helm$/ { found=1; next }
    found && /^[[:space:]]*- name:/ { exit }
    found && /^[[:space:]]*version:[[:space:]]*"/ {
      gsub(/^[[:space:]]*version:[[:space:]]*"|"[[:space:]]*$/, "")
      print; exit
    }
  ' "$1"
}

docker_version="$(sed -n 's/^ARG DAGGER_VERSION=v\{0,1\}\([0-9][^[:space:]]*\)$/\1/p' "$dockerfile")"
cargo_version="$(sed -n 's/^dagger-sdk = "=\([0-9][^"]*\)"$/\1/p' "$cargo_toml")"
archestra_chart_version="$(dagger_helm_chart_version "$archestra_chart")"
dagger_runtime_chart_version="$(dagger_helm_chart_version "$dagger_runtime_chart")"
dagger_runtime_app_version="$(sed -n 's/^appVersion: "\([0-9][^"]*\)"$/\1/p' "$dagger_runtime_chart")"
bench_dagger_version="$(sed -n 's#^[[:space:]]*image:[[:space:]]*registry.dagger.io/engine:v\{0,1\}\([0-9][^"[:space:]]*\)[[:space:]]*$#\1#p' "$bench_dagger_compose")"

case "$docker_version:$cargo_version:$archestra_chart_version:$dagger_runtime_chart_version:$dagger_runtime_app_version:$bench_dagger_version" in
  *::* | :* | *:)
    echo "failed to read Dagger versions from Dockerfile, archestra-rs/sandbox-core/Cargo.toml, Helm charts, and ai-labs/dev/docker-compose.bench-dagger.yml" >&2
    exit 1
    ;;
  "$cargo_version:$cargo_version:$cargo_version:$cargo_version:$cargo_version:$cargo_version")
    exit 0
    ;;
  *)
    echo "Dagger version mismatch: Dockerfile has $docker_version, dagger-sdk has $cargo_version, archestra chart has $archestra_chart_version, dagger-runtime chart has $dagger_runtime_chart_version, dagger-runtime appVersion has $dagger_runtime_app_version, bench-dagger compose has $bench_dagger_version" >&2
    exit 1
    ;;
esac
