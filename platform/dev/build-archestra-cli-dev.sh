#!/usr/bin/env sh
# Builds the `archestra` program (platform/archestra-cli) for this computer and
# puts it where the local backend serves it from, so that the install command
# of a local Archestra downloads the program of this checkout. In the dev VM it
# also builds it for the Mac (see the end of the script).
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
place() {
  cp "$1" "$out/.$2.tmp"
  mv "$out/.$2.tmp" "$out/$2"
}
place target/release/archestra "archestra-$system-$cpu"
printf '{ "version": "%s-dev" }\n' "$version" > "$out/manifest.json"
echo "archestra $version-dev for $system-$cpu is in $out"

# In the dev VM (platform/dev/vm), Archestra runs on Linux but the browser and
# the install command run on the Mac, so also build the program for macOS on
# the VM's CPU. It needs the macOS SDK that `dev-vm.sh create` copies from the
# Mac, clang, and lld. Without the SDK (any other Linux computer) this is
# skipped.
sdk="${SDKROOT:-$HOME/.local/share/macos-sdk/MacOSX.sdk}"
if [ "$system" = linux ] && [ -d "$sdk" ]; then
  case "$cpu" in
    arm64) triple=aarch64-apple-darwin; clang_target=arm64-apple-macos11 ;;
    x86_64) triple=x86_64-apple-darwin; clang_target=x86_64-apple-macos11 ;;
  esac
  # Ubuntu names it ld64.lld-<llvm version>.
  lld="$(command -v ld64.lld || ls /usr/bin/ld64.lld-* 2>/dev/null | sort -V | tail -n 1)"
  if [ -z "$lld" ]; then
    echo "build-archestra-cli-dev.sh: no ld64.lld for the macOS build: sudo apt-get install lld llvm" >&2
    exit 1
  fi
  rustup target add "$triple"
  # Variables for this target only, so C code built for the VM is unchanged.
  # clang can't ask a linker on Linux for its ld64 version, and without one it
  # passes flags that ld64.lld refuses: -mlinker-version names one.
  # ld64.lld signs the program ad hoc, which Apple Silicon requires.
  under="$(echo "$triple" | tr - _)"
  upper="$(echo "$under" | tr '[:lower:]' '[:upper:]')"
  env \
    SDKROOT="$sdk" \
    MACOSX_DEPLOYMENT_TARGET=11.0 \
    CARGO_TARGET_DIR="$PWD/target" \
    "CC_$under=clang" \
    "AR_$under=llvm-ar" \
    "CFLAGS_$under=--target=$clang_target -isysroot $sdk" \
    "CARGO_TARGET_${upper}_LINKER=clang" \
    "CARGO_TARGET_${upper}_RUSTFLAGS=-C link-arg=--target=$clang_target -C link-arg=-isysroot -C link-arg=$sdk -C link-arg=-fuse-ld=$lld -C link-arg=-mlinker-version=907" \
    cargo build --release --locked --target "$triple"
  place "target/$triple/release/archestra" "archestra-darwin-$cpu"
  echo "archestra $version-dev for darwin-$cpu is in $out"
fi
