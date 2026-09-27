#!/usr/bin/env bash
set -euo pipefail

rustup show
if [[ -n "${RUST_TARGETS:-}" ]]; then
  read -ra targets <<< "$RUST_TARGETS"
  rustup target add "${targets[@]}"
fi
