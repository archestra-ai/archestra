#!/usr/bin/env bash
# Runs the Archestra dev stack inside a Lima VM that has no host folders and
# no host credentials. See platform/dev/vm/README.md.
#
# Usage: dev-vm.sh <command>
#   create          create and start the VM, install the toolchain
#   clone           clone archestra into ~/archestra in the VM (public https)
#   worktree <name> [base]  add a worktree ~/worktrees/<name> in the VM (branch <name>,
#                   from <base>, default main); it shares the VM's pnpm and Rust caches
#   push <branch>   copy a local branch into the VM's clone (git bundle, no push access needed)
#   cluster         create the kind cluster "archestra" in the VM
#   tilt [name]     run `tilt up` in ~/archestra, or in worktree <name> (UI on http://localhost:20350)
#   shell [name]    open a shell in the VM, in ~/archestra/platform or the worktree's platform/
#   ssh-config      print the SSH settings for VS Code / Cursor Remote-SSH and git
#   remote          add the git remote "vm" to the Mac repo you're in: commit in the VM,
#                   `git fetch vm` on the Mac, review, push from the Mac
#   start | stop | status | delete
#
# Env: ARCHESTRA_DEV_VM (VM name, default archestra-dev),
#      ARCHESTRA_DEV_VM_CPUS / ARCHESTRA_DEV_VM_MEMORY (GiB) / ARCHESTRA_DEV_VM_DISK (GiB)
set -euo pipefail

vm="${ARCHESTRA_DEV_VM:-archestra-dev}"
here="$(cd "$(dirname "$0")" && pwd)"
platform="$(cd "$here/.." && pwd)"
template="$platform/dev/vm/archestra-dev.yaml"
repo_url="https://github.com/archestra-ai/archestra.git"
# Mac-side ports (guest port + 10000), from archestra-dev.yaml.
frontend_url="http://localhost:13000"
api_url="http://localhost:19000"

# platform/ of the main clone, or of worktree <name>.
checkout_dir() { if [ -n "${1:-}" ]; then echo "~/worktrees/$1/platform"; else echo "~/archestra/platform"; fi; }

die() { echo "dev-vm.sh: $*" >&2; exit 1; }
need_lima() { command -v limactl >/dev/null || die "install Lima first: brew install lima"; }
exists() { limactl list -q 2>/dev/null | grep -qx "$vm"; }
in_vm() { limactl shell --workdir / "$vm" -- bash -lc "$1"; }
# </dev/null: limactl shell forwards stdin.
vm_user() { limactl shell --workdir / "$vm" -- id -un </dev/null; }

cmd_create() {
  need_lima
  exists && die "VM $vm already exists (dev-vm.sh delete to start over)"
  local args=()
  [ -n "${ARCHESTRA_DEV_VM_CPUS:-}" ] && args+=(--cpus "$ARCHESTRA_DEV_VM_CPUS")
  [ -n "${ARCHESTRA_DEV_VM_MEMORY:-}" ] && args+=(--memory "$ARCHESTRA_DEV_VM_MEMORY")
  [ -n "${ARCHESTRA_DEV_VM_DISK:-}" ] && args+=(--disk "$ARCHESTRA_DEV_VM_DISK")
  # ${args[@]+...}: macOS bash 3.2 treats an empty array as unset under set -u.
  limactl create --tty=false --name "$vm" ${args[@]+"${args[@]}"} "$template"
  limactl start --tty=false "$vm"
  cmd_setup
}

cmd_setup() {
  limactl copy "$platform/dev/vm/setup-vm.sh" "$vm:/tmp/setup-vm.sh"
  limactl shell --workdir / "$vm" -- sudo bash /tmp/setup-vm.sh "$(vm_user)" </dev/null
  # The docker group applies to new logins; restart so the SSH session gets it.
  limactl stop "$vm" && limactl start --tty=false "$vm"
  echo
  echo "Next: dev-vm.sh clone && dev-vm.sh cluster && dev-vm.sh tilt"
}

cmd_clone() {
  in_vm "
    set -e
    [ -d ~/archestra/.git ] || git clone $repo_url ~/archestra
    cd ~/archestra/platform
    # The Mac reaches the VM's frontend and API on shifted ports, and auth
    # trusts only the origin in ARCHESTRA_FRONTEND_URL.
    [ -f .env ] || cp .env.example .env
    sed -i 's|^ARCHESTRA_FRONTEND_URL=.*|ARCHESTRA_FRONTEND_URL=$frontend_url|' .env
    sed -i 's|^ARCHESTRA_API_BASE_URL=.*|ARCHESTRA_API_BASE_URL=$api_url|' .env
    # Tilt builds the OpenAPPA addon only with ARCHESTRA_BETA=true; without it
    # the backend's /ready stays 503 and the login page says it can't reach
    # the server.
    sed -i 's|^ARCHESTRA_BETA=.*|ARCHESTRA_BETA=true|' .env
    rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install
    grep -E '^ARCHESTRA_(FRONTEND_URL|API_BASE_URL|BETA)=' .env
  "
}

cmd_push() {
  local branch="${1:?usage: dev-vm.sh push <branch>}"
  local tmp
  tmp="$(mktemp -d)"
  git -C "$platform" bundle create "$tmp/push.bundle" "$branch"
  limactl copy "$tmp/push.bundle" "$vm:/tmp/push.bundle"
  rm -rf "$tmp"
  in_vm "cd ~/archestra && git fetch /tmp/push.bundle '$branch:$branch' && rm /tmp/push.bundle && echo 'Branch $branch is in the VM: git -C ~/archestra switch $branch'"
}

cmd_worktree() {
  local name="${1:?usage: dev-vm.sh worktree <name> [base]}" base="${2:-main}"
  # Same repo as ~/archestra, so the Mac's "vm" remote sees its branches.
  # pnpm's store and Tilt's CARGO_TARGET_DIR are per VM user, so the first
  # install and Rust build reuse what ~/archestra already downloaded and built.
  in_vm "
    set -e
    cd ~/archestra
    if git show-ref -q --verify refs/heads/$name; then
      git worktree add ~/worktrees/$name $name
    else
      git worktree add -b $name ~/worktrees/$name $base
    fi
    cp ~/archestra/platform/.env ~/worktrees/$name/platform/.env
    echo 'Worktree ~/worktrees/$name is ready: dev-vm.sh tilt $name (one Tilt at a time: stop the other first)'
  "
}

cmd_cluster() {
  in_vm "kind get clusters 2>/dev/null | grep -qx archestra || kind create cluster --name archestra; kubectl config use-context kind-archestra"
}

cmd_tilt() {
  in_vm "cd $(checkout_dir "${1:-}") && exec tilt up --context kind-archestra"
}

cmd_shell() { limactl shell --workdir / "$vm" -- bash -lc "cd $(checkout_dir "${1:-}") 2>/dev/null || cd; exec bash -l"; }

cmd_remote() {
  local top url="lima-$vm:archestra"
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run it inside the Mac git repo to push from"
  if git -C "$top" remote get-url vm >/dev/null 2>&1; then
    git -C "$top" remote set-url vm "$url"
  else
    git -C "$top" remote add vm "$url"
  fi
  echo "remote vm -> $url in $top"
  # ssh -G prints the settings ssh would use; without the Include the host stays unknown.
  if [ "$(ssh -G "lima-$vm" 2>/dev/null | awk '$1 == "hostname" { print $2 }')" != "127.0.0.1" ]; then
    echo "ssh doesn't know lima-$vm yet: add the lines from 'dev-vm.sh ssh-config' to the top of ~/.ssh/config"
  fi
}

cmd_ssh_config() {
  local cfg="$HOME/.lima/$vm/ssh.config"
  [ -f "$cfg" ] || die "no $cfg yet (dev-vm.sh create first)"
  cat <<EOF
# Add to the top of ~/.ssh/config. Then git ("vm" remote) and VS Code / Cursor
# (Remote-SSH: Connect to Host... -> lima-$vm, folder ~/archestra/platform)
# reach the VM by name.
Include $cfg
Host lima-$vm
  ForwardAgent no
  ForwardX11 no
# Back to settings for every host, so the lines below stay as they were.
Match all
EOF
  echo
  echo "# And in VS Code / Cursor user settings, so the editor doesn't hand your"
  echo "# Mac's SSH agent or Git credentials to the VM:"
  echo '#   "remote.SSH.enableAgentForwarding": false,'
  echo '#   "git.terminalAuthentication": false'
}

cmd="${1:-}"; shift || true
case "$cmd" in
  create) cmd_create ;;
  setup) cmd_setup ;;
  clone) cmd_clone ;;
  worktree) cmd_worktree "$@" ;;
  push) cmd_push "$@" ;;
  cluster) cmd_cluster ;;
  tilt) cmd_tilt "$@" ;;
  shell) cmd_shell "$@" ;;
  ssh-config) cmd_ssh_config ;;
  remote) cmd_remote ;;
  start) limactl start --tty=false "$vm" ;;
  stop) limactl stop "$vm" ;;
  status) limactl list "$vm" ;;
  delete) limactl delete --force "$vm" ;;
  *) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; [ -z "$cmd" ] || exit 1 ;;
esac
