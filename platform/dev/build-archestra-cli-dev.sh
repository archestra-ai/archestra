#!/usr/bin/env sh
# Builds the `archestra` program (platform/archestra-cli) for this computer and
# puts it where the local backend serves it from, so that the install command
# of a local Archestra downloads the program of this checkout.
#
# Usage: build-archestra-cli-dev.sh [folder]   (default: archestra-cli/target/dev-clients)
#
# The folder gets `archestra-<system>-<cpu>` and `manifest.json`. The version
# in the manifest is the one of Cargo.toml with `-dev`, so the Device tab shows
# that a local build runs. Tilt sets ARCHESTRA_CLI_DIR to this folder.
set -eu

cd "$(dirname "$0")/../archestra-cli"
out="${1:-$PWD/target/dev-clients}"

case "$(uname -s)" in
  Darwin) system=darwin ;;
  Linux) system=linux ;;
  *) echo "build-archestra-cli-dev.sh: build on Windows by hand (see archestra-cli/README.md)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) cpu=arm64 ;;
  x86_64 | amd64) cpu=x86_64 ;;
  *) echo "build-archestra-cli-dev.sh: unknown CPU $(uname -m)" >&2; exit 1 ;;
esac

# The target folder of this workspace, also when Tilt points cargo at a shared
# one: the script must know where the program is.
CARGO_TARGET_DIR="$PWD/target" cargo build --release --locked

version="$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml | head -n 1)"
if [ -z "$version" ]; then
  echo "build-archestra-cli-dev.sh: no version in Cargo.toml" >&2
  exit 1
fi

mkdir -p "$out"
# In one step: the backend never serves half a file.
cp target/release/archestra "$out/.archestra-$system-$cpu.tmp"
mv "$out/.archestra-$system-$cpu.tmp" "$out/archestra-$system-$cpu"
printf '{ "version": "%s-dev" }\n' "$version" > "$out/manifest.json"
echo "archestra $version-dev for $system-$cpu is in $out"
