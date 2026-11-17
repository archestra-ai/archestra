#!/usr/bin/env bash
# Installs the Archestra dev toolchain inside the Lima VM. Runs as root inside
# the VM (dev-vm.sh copies it in and runs it); safe to run again.
#
# Usage: sudo setup-vm.sh <user>
#
# Every download is pinned to a version and checked against the checksum its
# project publishes. Versions match the ones the Mac setup uses.
set -euo pipefail

user="${1:?usage: sudo setup-vm.sh <user>}"

KIND_VERSION=v0.32.0
KUBECTL_VERSION=v1.34.1
HELM_VERSION=v4.0.1
TILT_VERSION=0.36.0
NODE_MAJOR=24

case "$(uname -m)" in
  aarch64 | arm64) arch=arm64; rust_triple=aarch64-unknown-linux-gnu ;;
  x86_64 | amd64) arch=amd64; rust_triple=x86_64-unknown-linux-gnu ;;
  *) echo "setup-vm.sh: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
node_arch="${arch/amd64/x64}"
tilt_arch="${arch/amd64/x86_64}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

fetch() { curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"; }
# check <file> <expected sha256>
check() { echo "$2  $1" | sha256sum -c --quiet -; }

step() { printf '\n==> %s\n' "$*"; }

step "apt packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# cmake/clang/libssl-dev/pkg-config: native parts of the Rust crates
# (aws-lc-sys, openssl-sys). lsof: Tilt's MCP port-forward loop.
apt-get install -y -q --no-install-recommends \
  build-essential pkg-config cmake clang libssl-dev \
  git curl ca-certificates jq lsof unzip xz-utils python3 tmux \
  docker.io
usermod -aG docker "$user"
systemctl enable --now docker

step "file watch limits (kind, Tilt, Next.js hot reload)"
cat > /etc/sysctl.d/90-archestra-dev.conf <<'EOF'
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 8192
EOF
sysctl -q --system

step "Node.js ${NODE_MAJOR}"
fetch "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" SHASUMS256.txt
node_tar="$(grep -oE "node-v[0-9.]+-linux-${node_arch}\.tar\.xz" SHASUMS256.txt | head -n 1)"
node_version="${node_tar#node-}"; node_version="${node_version%%-linux*}"
if [ "$(node --version 2>/dev/null || true)" != "$node_version" ]; then
  fetch "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${node_tar}" "$node_tar"
  check "$node_tar" "$(awk -v f="$node_tar" '$2 == f { print $1 }' SHASUMS256.txt)"
  rm -rf /usr/local/lib/nodejs
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$node_tar" -C /usr/local/lib/nodejs --strip-components=1
  for bin in node npm npx corepack; do
    ln -sf "/usr/local/lib/nodejs/bin/$bin" "/usr/local/bin/$bin"
  done
fi
# pnpm comes from corepack, at the version platform/package.json pins.
corepack enable --install-directory /usr/local/bin
node --version

step "kubectl ${KUBECTL_VERSION}"
fetch "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl" kubectl
fetch "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl.sha256" kubectl.sha256
check kubectl "$(cat kubectl.sha256)"
install -m 0755 kubectl /usr/local/bin/kubectl

step "kind ${KIND_VERSION}"
fetch "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${arch}" kind
fetch "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${arch}.sha256sum" kind.sha256sum
check kind "$(awk '{ print $1 }' kind.sha256sum)"
install -m 0755 kind /usr/local/bin/kind

step "helm ${HELM_VERSION}"
helm_tar="helm-${HELM_VERSION}-linux-${arch}.tar.gz"
fetch "https://get.helm.sh/${helm_tar}" "$helm_tar"
fetch "https://get.helm.sh/${helm_tar}.sha256sum" helm.sha256sum
check "$helm_tar" "$(awk '{ print $1 }' helm.sha256sum)"
tar -xzf "$helm_tar"
install -m 0755 "linux-${arch}/helm" /usr/local/bin/helm

step "tilt ${TILT_VERSION}"
tilt_tar="tilt.${TILT_VERSION}.linux.${tilt_arch}.tar.gz"
fetch "https://github.com/tilt-dev/tilt/releases/download/v${TILT_VERSION}/${tilt_tar}" "$tilt_tar"
fetch "https://github.com/tilt-dev/tilt/releases/download/v${TILT_VERSION}/checksums.txt" tilt.checksums
check "$tilt_tar" "$(awk -v f="$tilt_tar" '$2 == f { print $1 }' tilt.checksums)"
tar -xzf "$tilt_tar" tilt
install -m 0755 tilt /usr/local/bin/tilt

step "rustup (toolchain comes from platform/rust-toolchain.toml)"
if ! sudo -iu "$user" sh -c 'command -v rustup' >/dev/null 2>&1; then
  fetch "https://static.rust-lang.org/rustup/dist/${rust_triple}/rustup-init" rustup-init
  fetch "https://static.rust-lang.org/rustup/dist/${rust_triple}/rustup-init.sha256" rustup-init.sha256
  check rustup-init "$(awk '{ print $1 }' rustup-init.sha256)"
  install -m 0755 rustup-init /tmp/rustup-init
  sudo -iu "$user" /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none
  rm -f /tmp/rustup-init
fi
# Login shells (limactl shell, ssh, VS Code terminals) get cargo on PATH.
cat > /etc/profile.d/archestra-dev.sh <<'EOF'
[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
EOF

step "done"
