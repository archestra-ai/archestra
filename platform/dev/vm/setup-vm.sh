#!/usr/bin/env bash
# Installs the Archestra dev toolchain inside the Lima VM. Runs as root inside
# the VM (dev-vm.sh copies it in and runs it with sudo). Safe to run again:
# what is already installed at the wanted version is skipped.
#
# Usage: sudo setup-vm.sh <node-version>
#
# Every download is pinned to a version and checked against the checksum its
# project publishes. Node's version is CI's (.github/actions/setup-env), passed
# in by dev-vm.sh; the repo has no pin for the other tools, so they are here.
set -euo pipefail

NODE_VERSION="${1:?usage: sudo setup-vm.sh <node-version>}"
KIND_VERSION=v0.32.0
KUBECTL_VERSION=v1.34.1
HELM_VERSION=v4.0.1
TILT_VERSION=0.36.0
user="${SUDO_USER:?run with sudo from the VM user}"

case "$(uname -m)" in
  aarch64 | arm64) arch=arm64; rust_triple=aarch64-unknown-linux-gnu ;;
  x86_64 | amd64) arch=amd64; rust_triple=x86_64-unknown-linux-gnu ;;
  *) echo "setup-vm.sh: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

step() { printf '\n==> %s\n' "$*"; }
fetch() { curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"; }
# get <url> <checksums-url>: downloads the file into the work folder and checks
# its sha256. The checksums file is a list that names the file, or holds one
# hash on its first line.
get() {
  local file="${1##*/}" want
  fetch "$1" "$file"
  fetch "$2" "$file.sums"
  want="$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1 }' "$file.sums")"
  [ -n "$want" ] || want="$(awk 'NR == 1 { print $1 }' "$file.sums")"
  echo "$want  $file" | sha256sum -c --quiet -
}

step "apt packages"
# cmake/clang/libssl-dev/pkg-config: native parts of the Rust crates
# (aws-lc-sys, openssl-sys). lsof: Tilt's MCP port-forward loop. socat: the
# kind bridge below. lld/llvm: the macOS build of the archestra program for
# the Mac (dev/build-archestra-cli-dev.sh).
packages="build-essential pkg-config cmake clang lld llvm libssl-dev git curl ca-certificates lsof xz-utils python3 docker.io socat"
# shellcheck disable=SC2086
if ! dpkg -s $packages >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q --no-install-recommends $packages
fi
usermod -aG docker "$user"
systemctl enable --now docker

step "file watch limits (kind, Tilt, Next.js hot reload)"
cat > /etc/sysctl.d/90-archestra-dev.conf <<'EOF'
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 8192
EOF
sysctl -q --system

step "Node.js ${NODE_VERSION}"
if [ "$(node --version 2>/dev/null || true)" != "v${NODE_VERSION}" ]; then
  node_tar="node-v${NODE_VERSION}-linux-${arch/amd64/x64}.tar.xz"
  get "https://nodejs.org/dist/v${NODE_VERSION}/${node_tar}" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  rm -rf /usr/local/lib/nodejs
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$node_tar" -C /usr/local/lib/nodejs --strip-components=1
  for bin in node npm npx corepack; do
    ln -sf "/usr/local/lib/nodejs/bin/$bin" "/usr/local/bin/$bin"
  done
fi
# pnpm comes from corepack, at the version platform/package.json pins.
corepack enable --install-directory /usr/local/bin

step "kubectl ${KUBECTL_VERSION}"
if ! kubectl version --client 2>/dev/null | grep -qF "$KUBECTL_VERSION"; then
  url="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"
  get "$url" "$url.sha256"
  install -m 0755 kubectl /usr/local/bin/kubectl
fi

step "kind ${KIND_VERSION}"
if ! kind version 2>/dev/null | grep -qF "kind $KIND_VERSION "; then
  url="https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${arch}"
  get "$url" "$url.sha256sum"
  install -m 0755 "kind-linux-${arch}" /usr/local/bin/kind
fi

step "helm ${HELM_VERSION}"
if ! helm version --short 2>/dev/null | grep -qF "${HELM_VERSION}+"; then
  url="https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz"
  get "$url" "$url.sha256sum"
  tar -xzf "${url##*/}"
  install -m 0755 "linux-${arch}/helm" /usr/local/bin/helm
fi

step "tilt ${TILT_VERSION}"
if ! tilt version 2>/dev/null | grep -qF "v${TILT_VERSION},"; then
  release="https://github.com/tilt-dev/tilt/releases/download/v${TILT_VERSION}"
  tilt_tar="tilt.${TILT_VERSION}.linux.${arch/amd64/x86_64}.tar.gz"
  get "$release/$tilt_tar" "$release/checksums.txt"
  tar -xzf "$tilt_tar" tilt
  install -m 0755 tilt /usr/local/bin/tilt
fi

step "rustup (toolchain comes from platform/rust-toolchain.toml)"
if ! sudo -iu "$user" sh -c 'command -v rustup' >/dev/null 2>&1; then
  url="https://static.rust-lang.org/rustup/dist/${rust_triple}/rustup-init"
  get "$url" "$url.sha256"
  install -m 0755 rustup-init /tmp/rustup-init
  sudo -iu "$user" /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none
  rm -f /tmp/rustup-init
fi
# Login shells (dev-vm.sh shell, editor terminals) get cargo, and the Rust
# build folder Tilt uses (platform/Tiltfile), so a cargo run by hand shares it.
cat > /etc/profile.d/archestra-dev.sh <<'EOF'
[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/.cache/archestra-rs-target"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
EOF

step "bridge from kind to the backend (Agent Runtime)"
# The dev backend listens on 127.0.0.1:9000 in the VM. Agent Runtime pods in
# kind call it back (LLM proxy, MCP gateway), so this forwards the kind
# network's gateway, port 9000, to it. On Docker Desktop, host.docker.internal
# plays this part. setup-checkout.sh starts it once the kind network exists and
# reads the gateway from it for ARCHESTRA_AGENT_RUNTIME_PLATFORM_BASE_URL.
cat > /usr/local/sbin/archestra-kind-backend-bridge <<'EOF'
#!/bin/sh
# archestra-kind-backend-bridge [gateway]: forwards, or only prints the gateway.
set -eu
gw="$(docker network inspect kind -f '{{range .IPAM.Config}}{{println .Gateway}}{{end}}' 2>/dev/null | grep -E '^[0-9.]+$' | head -n 1)"
if [ -z "$gw" ]; then
  echo "no kind network" >&2
  exit 1
fi
if [ "${1:-}" = gateway ]; then
  echo "$gw"
  exit 0
fi
exec socat TCP-LISTEN:9000,bind="$gw",reuseaddr,fork TCP:127.0.0.1:9000
EOF
chmod 0755 /usr/local/sbin/archestra-kind-backend-bridge
cat > /etc/systemd/system/archestra-kind-backend-bridge.service <<'EOF'
[Unit]
Description=Forward the kind network's gateway:9000 to the dev backend on 127.0.0.1:9000
After=docker.service
Requires=docker.service

[Service]
# Not started (and not retried) while there is no kind network.
ExecCondition=/usr/local/sbin/archestra-kind-backend-bridge gateway
ExecStart=/usr/local/sbin/archestra-kind-backend-bridge
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q archestra-kind-backend-bridge.service

step "done"
