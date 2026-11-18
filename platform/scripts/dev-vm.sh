#!/usr/bin/env bash
# Manages the Lima VM that runs the Archestra dev stack without host folders
# and host credentials. Your code gets into it with dev-vm-sync.py. See
# platform/dev/vm/README.md.
#
# Usage: dev-vm.sh <command>
#   create          create the VM, install the tools (Node, Rust, kind, Tilt...),
#                   create the kind cluster and add the VM to ~/.ssh/config.
#                   Safe to run again: finished steps are skipped.
#   start | stop | status | delete
#
# Env: ARCHESTRA_DEV_VM (VM name, default archestra-dev); for create also
#      ARCHESTRA_DEV_VM_CPUS / ARCHESTRA_DEV_VM_MEMORY (GiB) / ARCHESTRA_DEV_VM_DISK (GiB)
set -euo pipefail

vm="${ARCHESTRA_DEV_VM:-archestra-dev}"
platform="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(git -C "$platform" rev-parse --show-toplevel)"

die() { echo "dev-vm.sh: $*" >&2; exit 1; }
vm_shell() { limactl shell --workdir / "$vm" -- "$@"; }
# Runs a bash command line in the VM in a login shell (PATH with cargo and
# pnpm). limactl shell forwards stdin; a command must not eat the caller's.
in_vm() { vm_shell bash -lc "$1" </dev/null; }

# The macOS SDK of the Mac's Command Line Tools, into ~/.local/share/macos-sdk
# in the VM: Tilt's archestra-cli-build builds the archestra program for the
# Mac with it (dev/build-archestra-cli-dev.sh). Headers and library stubs only.
copy_macos_sdk() {
  local sdk
  if in_vm "test -d ~/.local/share/macos-sdk/MacOSX.sdk"; then return; fi
  sdk="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)" || sdk=""
  if [ -z "$sdk" ]; then
    echo "No macOS SDK (xcode-select --install): the VM won't build the archestra program for this Mac."
    return
  fi
  # MacOSX.sdk is a link to the versioned folder; the folder keeps its own links.
  sdk="$(cd "$sdk" && pwd -P)"
  echo "Copying the macOS SDK $(basename "$sdk") into the VM..."
  tar -C "$(dirname "$sdk")" -cf - "$(basename "$sdk")" 2>/dev/null |
    vm_shell sh -c "mkdir -p ~/.local/share/macos-sdk && tar -C ~/.local/share/macos-sdk -xf - 2>/dev/null && ln -sfn $(printf %q "$(basename "$sdk")") ~/.local/share/macos-sdk/MacOSX.sdk" ||
    die "copying the macOS SDK into the VM failed"
}

cmd_create() {
  local node_version
  command -v limactl >/dev/null || die "install Lima first: brew install lima"
  # The Node version CI uses.
  node_version="$(sed -n 's/.*node-version: "\(.*\)".*/\1/p' "$repo/.github/actions/setup-env/action.yml" | head -n 1)"
  [ -n "$node_version" ] || die "no node-version in .github/actions/setup-env/action.yml"

  if ! limactl list -q 2>/dev/null | grep -qx "$vm"; then
    # shellcheck disable=SC2086
    limactl create --tty=false --name "$vm" \
      ${ARCHESTRA_DEV_VM_CPUS:+--cpus "$ARCHESTRA_DEV_VM_CPUS"} \
      ${ARCHESTRA_DEV_VM_MEMORY:+--memory "$ARCHESTRA_DEV_VM_MEMORY"} \
      ${ARCHESTRA_DEV_VM_DISK:+--disk "$ARCHESTRA_DEV_VM_DISK"} \
      "$platform/dev/vm/archestra-dev.yaml"
  fi
  [ "$(limactl list --format '{{.Status}}' "$vm")" = Running ] || limactl start --tty=false "$vm"

  limactl copy "$platform/dev/vm/setup-vm.sh" "$platform/rust-toolchain.toml" "$vm:/tmp/"
  vm_shell sudo bash /tmp/setup-vm.sh "$node_version" </dev/null
  # A new SSH session, so the docker group from setup-vm.sh applies. Only when
  # it doesn't yet: --reconnect closes the shared SSH connection, and with it
  # every session on it, a running `tilt up` too.
  if ! vm_shell id -nG </dev/null | grep -qw docker; then
    limactl shell --reconnect --workdir / "$vm" -- true </dev/null
  fi
  copy_macos_sdk
  # The Rust version, components and targets platform/rust-toolchain.toml names.
  in_vm "cd /tmp && rustup toolchain install"

  # The kind cluster, then the bridge from it to the backend (setup-vm.sh),
  # which needs the kind network.
  in_vm "kind get clusters 2>/dev/null | grep -qx archestra || kind create cluster --name archestra"
  in_vm "kubectl config use-context kind-archestra >/dev/null && sudo systemctl restart archestra-kind-backend-bridge"

  add_ssh_config

  echo
  echo "Ready. Next, in your checkout: platform/scripts/dev-vm-sync.py start."
}

# Mutagen and `ssh lima-<vm>` use your own ssh, so ~/.ssh/config must know the
# VM. At the top: ssh takes the first value it finds for a setting, so this
# block's ForwardAgent no wins over a `Host *` below. `Match all` ends the
# block, so the lines after it apply as before.
add_ssh_config() {
  local cfg="$HOME/.ssh/config" include="Include $HOME/.lima/$vm/ssh.config" tmp
  grep -qxF "$include" "$cfg" 2>/dev/null && return
  if [ -L "$cfg" ] || { [ -e "$cfg" ] && [ ! -w "$cfg" ]; }; then
    echo "~/.ssh/config is a link or read-only. Add these lines to its top yourself:"
    ssh_block "$include"
    return
  fi
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  tmp="$(mktemp "$cfg.XXXXXX")"
  { ssh_block "$include"; echo; cat "$cfg" 2>/dev/null || true; } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$cfg"
  echo "Added lima-$vm to the top of ~/.ssh/config (the block marked archestra dev VM)."
}

ssh_block() {
  cat <<EOF
# >>> archestra dev VM (platform/scripts/dev-vm.sh): lets Mutagen and ssh reach it as lima-$vm
$1
Host lima-$vm
  ForwardAgent no
  ForwardX11 no
Match all
# <<< archestra dev VM
EOF
}

cmd="${1:-}"
shift || true
case "$cmd" in
  create) cmd_create ;;
  start) limactl start --tty=false "$vm" ;;
  stop) limactl stop "$vm" ;;
  status) limactl list "$vm" ;;
  delete) limactl delete --force "$vm" ;;
  *)
    awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
    [ -z "$cmd" ] || exit 1
    ;;
esac
