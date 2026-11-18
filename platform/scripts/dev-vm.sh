#!/usr/bin/env bash
# Runs the Archestra dev stack inside a Lima VM that has no host folders and
# no host credentials. See platform/dev/vm/README.md.
#
# Usage: dev-vm.sh <command>
#   create [ref]    create the VM, install the toolchain, push this repo's <ref> (default
#                   main) into ~/archestra, create the kind cluster and write the VM's
#                   .env. Safe to run again: finished steps are skipped.
#   shell [-w <worktree>] [command]
#                   open a shell in the VM, in ~/archestra/platform or the worktree's
#                   platform/; with a command, run it there (quote shell syntax as one
#                   string). `tilt up` there starts the stack.
#   push <branch>   send a Mac branch into the VM's repo as mac/<branch> (only the new commits)
#   worktree <name> [base]
#                   add ~/worktrees/<name> in the VM on branch <name> (from <base>, default
#                   main); it shares the VM's .env, pnpm store and Rust build folder
#   remote          add the git remote "vm" to this repo: commit in the VM, `git fetch vm`
#                   on the Mac, review, push from the Mac
#   ssh-config      print the SSH settings that let git and editors reach the VM by name
#   start | stop | status | delete
#
# Env: ARCHESTRA_DEV_VM (VM name, default archestra-dev); for create also
#      ARCHESTRA_DEV_VM_CPUS / ARCHESTRA_DEV_VM_MEMORY (GiB) / ARCHESTRA_DEV_VM_DISK (GiB)
set -euo pipefail

vm="${ARCHESTRA_DEV_VM:-archestra-dev}"
platform="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(git -C "$platform" rev-parse --show-toplevel)"

die() { echo "dev-vm.sh: $*" >&2; exit 1; }
# Names end up in commands run in the VM: plain branch and folder names only.
plain() { case "$1" in '' | -* | *[!A-Za-z0-9._/@-]*) die "not a plain name: $1" ;; esac; }
vm_shell() { limactl shell --workdir / "$vm" -- "$@"; }
# Runs a bash command line in the VM in a login shell (PATH with cargo and
# pnpm). limactl shell forwards stdin; a command must not eat the caller's.
in_vm() { vm_shell bash -lc "$1" </dev/null; }

# The VM gets code only from the Mac: the Mac pushes into the VM's repo over
# Lima's SSH. The VM holds no GitHub credentials and has no git remotes. This
# repo may be a shallow clone.
push_to_vm() {
  # Lima's own ssh config, so it works without the ~/.ssh/config Include.
  # --no-verify: this repo's pre-push hooks aren't for this.
  GIT_SSH_COMMAND="ssh -F $HOME/.lima/$vm/ssh.config" \
    git -C "$repo" push --no-verify --quiet "lima-$vm:archestra" "$@"
}

cmd_create() {
  local ref="${1:-main}" commit node_version name email
  command -v limactl >/dev/null || die "install Lima first: brew install lima"
  plain "$ref"
  commit="$(git -C "$repo" rev-parse --verify --quiet "$ref^{commit}")" || die "no commit $ref in $repo"
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

  limactl copy "$platform/dev/vm/setup-vm.sh" "$platform/dev/vm/setup-checkout.sh" "$vm:/tmp/"
  vm_shell sudo bash /tmp/setup-vm.sh "$node_version" </dev/null
  # A new SSH session, so the docker group from setup-vm.sh applies.
  limactl shell --reconnect --workdir / "$vm" -- true </dev/null

  if in_vm "test ! -e ~/archestra"; then
    # shallowUpdate: this repo may be a shallow clone. updateInstead: a push
    # to the checked-out branch also updates the files.
    in_vm "git init -q -b main ~/archestra && git -C ~/archestra config receive.shallowUpdate true && git -C ~/archestra config receive.denyCurrentBranch updateInstead"
    echo "Pushing $ref ($commit) into the VM as main..."
    push_to_vm "$commit:refs/heads/main" || die "push into the VM failed"
    # Commits in the VM carry your Git name and email (not a credential).
    name="$(git -C "$repo" config user.name || true)"
    email="$(git -C "$repo" config user.email || true)"
    [ -z "$name" ] || in_vm "git config --global user.name $(printf %q "$name")"
    [ -z "$email" ] || in_vm "git config --global user.email $(printf %q "$email")"
  fi
  in_vm "bash /tmp/setup-checkout.sh"

  echo
  echo "Ready. Start the stack: dev-vm.sh shell, then 'tilt up' (first run about 8 minutes)."
  echo "Web UI http://localhost:13000, Tilt UI http://localhost:20350."
}

cmd_shell() {
  local dir="~/archestra/platform"
  if [ "${1:-}" = -w ]; then
    plain "${2:-}"
    dir="~/worktrees/$2/platform"
    shift 2
  fi
  if [ $# -eq 0 ]; then
    vm_shell bash -lc "cd $dir && exec bash -l"
  else
    vm_shell bash -lc "cd $dir && $*"
  fi
}

cmd_push() {
  local branch="${1:-}"
  plain "$branch"
  # Only one exact local branch, never --all or other revision options.
  git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch^{commit}" >/dev/null || die "no local branch $branch"
  # Into mac/<branch>, never over a VM branch you may be working on. Git
  # sends only the commits the VM doesn't have.
  push_to_vm "+refs/heads/$branch:refs/remotes/mac/$branch" || die "push into the VM failed (dev-vm.sh create first?)"
  echo "In the VM: mac/$branch. Start a branch from it: git switch -c $branch mac/$branch (or merge it into yours)."
}

cmd_worktree() {
  local name="${1:-}" base="${2:-main}"
  plain "$name"
  plain "$base"
  # Same repo as ~/archestra, so the Mac's "vm" remote sees its branches. The
  # .env link is what the repo's worktree hook (worktree-bootstrap.sh) makes;
  # the hook is only installed after the first `tilt up`.
  in_vm "
    set -e
    cd ~/archestra
    if git show-ref -q --verify refs/heads/$name; then
      git worktree add ~/worktrees/$name $name
    else
      git worktree add -b $name ~/worktrees/$name $base
    fi
    [ -e ~/worktrees/$name/platform/.env ] || ln -sfn ~/archestra/platform/.env ~/worktrees/$name/platform/.env
  "
  echo "Worktree ~/worktrees/$name is ready: dev-vm.sh shell -w $name (one Tilt at a time: stop the other first)."
}

cmd_remote() {
  git -C "$repo" remote remove vm 2>/dev/null || true
  git -C "$repo" remote add vm "lima-$vm:archestra"
  # The VM's tags are copies of this repo's.
  git -C "$repo" config remote.vm.tagOpt --no-tags
  echo "remote vm -> lima-$vm:archestra in $repo (needs the lines from 'dev-vm.sh ssh-config' in ~/.ssh/config)"
}

cmd_ssh_config() {
  local cfg="$HOME/.lima/$vm/ssh.config"
  [ -f "$cfg" ] || die "no $cfg yet (dev-vm.sh create first)"
  cat <<EOF
# Add to the top of ~/.ssh/config. Then git (the "vm" remote) and editors
# reach the VM as lima-$vm.
Include $cfg
Host lima-$vm
  ForwardAgent no
  ForwardX11 no
# Back to settings for every host, so the lines below stay as they were.
Match all
EOF
}

cmd="${1:-}"
shift || true
case "$cmd" in
  create) cmd_create "$@" ;;
  shell) cmd_shell "$@" ;;
  push) cmd_push "$@" ;;
  worktree) cmd_worktree "$@" ;;
  remote) cmd_remote ;;
  ssh-config) cmd_ssh_config ;;
  start) limactl start --tty=false "$vm" ;;
  stop) limactl stop "$vm" ;;
  status) limactl list "$vm" ;;
  delete) limactl delete --force "$vm" ;;
  *)
    awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"
    [ -z "$cmd" ] || exit 1
    ;;
esac
