#!/usr/bin/env bash
# zona's provision hook: installs Archestra's dev tools in the zona VM. Runs as
# root, in the VM copy's platform/ folder, on the first `zona start` of
# Archestra in a VM and again on `zona provision`. Safe to run again: what is
# already installed at the wanted version is skipped.
#
# zona already installed Docker, git and tmux. Every download is pinned and
# checked against the checksum its project publishes. Node's version is CI's,
# Rust's is platform/rust-toolchain.toml's; the other tools are pinned here.
set -euo pipefail

KIND_VERSION=v0.32.0
KUBECTL_VERSION=v1.34.1
HELM_VERSION=v4.0.1
TILT_VERSION=0.36.0
# The kind network's gateway, fixed so zona/env-override can name it.
KIND_SUBNET=172.30.0.0/16
KIND_GATEWAY=172.30.0.1
user="${SUDO_USER:?zona runs this with sudo from the VM user}"
repo="$ZONA_DIR/.."
as_user() { sudo -iu "$user" bash -lc "$1"; }

NODE_VERSION="$(sed -n 's/.*node-version: "\(.*\)".*/\1/p' "$repo/.github/actions/setup-env/action.yml" | head -n 1)"
[ -n "$NODE_VERSION" ] || { echo "provision.sh: no node-version in .github/actions/setup-env/action.yml" >&2; exit 1; }

case "$(uname -m)" in
  aarch64 | arm64) arch=arm64; rust_triple=aarch64-unknown-linux-gnu ;;
  x86_64 | amd64) arch=amd64; rust_triple=x86_64-unknown-linux-gnu ;;
  *) echo "provision.sh: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

step() { printf '\n==> %s\n' "$*"; }
fetch() { curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"; }
# get <url> <checksums-url>: downloads the file and checks its sha256. The
# checksums file names the file, or holds one hash on its first line.
get() {
  local file="${1##*/}" want
  fetch "$1" "$file"
  fetch "$2" "$file.sums"
  want="$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1 }' "$file.sums")"
  [ -n "$want" ] || want="$(awk 'NR == 1 { print $1 }' "$file.sums")"
  echo "$want  $file" | sha256sum -c --quiet -
}

step "apt packages"
# cmake/clang/libssl-dev/pkg-config: native parts of the Rust crates. lsof:
# Tilt's MCP port-forward loop. socat: the kind bridge below. zsh: the
# agent-connection-setup tests run the zsh startup wrapper.
packages="build-essential pkg-config cmake clang lld llvm libssl-dev lsof xz-utils python3 socat zsh jq"
# shellcheck disable=SC2086
if ! dpkg -s $packages >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q --no-install-recommends $packages
fi

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

step "rustup, and the toolchain platform/rust-toolchain.toml names"
if ! as_user 'command -v rustup' >/dev/null 2>&1; then
  url="https://static.rust-lang.org/rustup/dist/${rust_triple}/rustup-init"
  get "$url" "$url.sha256"
  install -m 0755 rustup-init /tmp/rustup-init
  sudo -iu "$user" /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none
  rm -f /tmp/rustup-init
fi
# cargo for login shells, which is how zona runs every command. Appended, so a
# project that pins its own Rust (a mise shim earlier on PATH) keeps it. No
# CARGO_TARGET_DIR here: it would apply to every project in the VM; the
# Tiltfile sets Archestra's own.
cat > /etc/profile.d/zona-archestra.sh <<'EOF'
case ":$PATH:" in *":$HOME/.cargo/bin:"*) ;; *) [ -d "$HOME/.cargo/bin" ] && PATH="$PATH:$HOME/.cargo/bin" ;; esac
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
EOF
as_user "cd $(printf %q "$repo/platform") && rustup toolchain install"

step "kind cluster archestra, on a network with a fixed gateway"
if ! docker network inspect kind >/dev/null 2>&1; then
  docker network create kind --subnet "$KIND_SUBNET" --gateway "$KIND_GATEWAY" \
    -o com.docker.network.bridge.enable_ip_masquerade=true -o com.docker.network.driver.mtu=1500 >/dev/null
fi
gw="$(docker network inspect kind -f '{{range .IPAM.Config}}{{println .Gateway}}{{end}}' | grep -E '^[0-9.]+$' | head -n 1)"
if [ "$gw" != "$KIND_GATEWAY" ]; then
  echo "provision.sh: the kind network's gateway is $gw, not $KIND_GATEWAY (zona/env-override names it)." >&2
  echo "Delete the cluster and the network (kind delete cluster --name archestra; docker network rm kind), then zona provision." >&2
  exit 1
fi
as_user "kind get clusters 2>/dev/null | grep -qx archestra || kind create cluster --name archestra"
as_user "kubectl config use-context kind-archestra >/dev/null"

step "bridge from kind to each worktree's backend (Agent Runtime)"
# Each worktree's backend listens on 127.0.0.1:\$ZONA_PORT_9000 in the VM.
# Agent Runtime pods call it back (LLM proxy, MCP gateway) through the kind
# network's gateway. One unit per port: start.sh starts this worktree's,
# cleanup.sh stops it.
cat > /etc/systemd/system/archestra-kind-bridge@.service <<EOF
[Unit]
Description=Forward ${KIND_GATEWAY}:%i (kind network) to an Archestra backend on 127.0.0.1:%i
After=docker.service
Requires=docker.service

[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:%i,bind=${KIND_GATEWAY},reuseaddr,fork TCP:127.0.0.1:%i
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

step "done"
