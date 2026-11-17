#!/usr/bin/env bash
# Checks the dev VM setup from the Mac: the VM, its isolation, SSH access and
# the "vm" git remote of the repo you run it in. Read-only; prints a fix for
# each failed check. Usage: check.sh  (env ARCHESTRA_DEV_VM, default archestra-dev)
set -uo pipefail

vm="${ARCHESTRA_DEV_VM:-archestra-dev}"
host="lima-$vm"
dev_vm="platform/scripts/dev-vm.sh"
failed=0
ok() { echo "✅ $*"; }
bad() { echo "❌ $1"; echo "   fix: $2"; failed=1; }
warn() { echo "⚠️  $*"; }

if ! command -v limactl >/dev/null; then
  bad "Lima is not installed" "brew install lima"
  exit 1
fi

status="$(limactl list --format '{{.Status}}' "$vm" 2>/dev/null)"
if [ -z "$status" ]; then
  bad "no VM named $vm" "$dev_vm create && $dev_vm clone && $dev_vm cluster"
  exit 1
fi
ok "VM $vm exists ($status)"

cfg="$HOME/.lima/$vm/lima.yaml"
if grep -qE '^mounts: \[\]' "$cfg"; then ok "no Mac folders mounted"; else bad "the VM mounts Mac folders" "set 'mounts: []' (limactl edit $vm), or recreate from platform/dev/vm/archestra-dev.yaml"; fi
if grep -qE '^  forwardAgent: false' "$cfg"; then ok "SSH agent not forwarded"; else bad "SSH agent forwarding not off" "set ssh.forwardAgent: false (limactl edit $vm)"; fi
if grep -qE '^  hostLoopback: false' "$cfg"; then ok "Mac localhost blocked (networkOpts.hostLoopback: false)"; else bad "the VM can reach the Mac's localhost" "limactl stop $vm && limactl edit --tty=false $vm --set '.networkOpts.hostLoopback = false' && limactl start $vm"; fi

if [ "$(ssh -G "$host" 2>/dev/null | awk '$1 == "hostname" { print $2 }')" = "127.0.0.1" ]; then
  ok "ssh knows $host"
else
  bad "ssh doesn't know $host" "add the lines from '$dev_vm ssh-config' to the top of ~/.ssh/config"
fi
if [ "$(ssh -G "$host" 2>/dev/null | awk '$1 == "forwardagent" { print $2 }')" = "yes" ]; then
  bad "ssh would forward your agent to $host" "remove ForwardAgent yes for this host (or Host *) in ~/.ssh/config"
fi

if top="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  url="$(git -C "$top" remote get-url vm 2>/dev/null)"
  if [ "$url" = "$host:archestra" ]; then
    ok "git remote vm -> $url in $top"
  elif [ -n "$url" ]; then
    bad "git remote vm points to $url" "$dev_vm remote"
  else
    bad "no git remote vm in $top" "$dev_vm remote"
  fi
else
  warn "not inside a git repo: run this from the Mac checkout you push from to check the vm remote"
fi

if [ "$status" = "Running" ]; then
  # Lima's own ssh config, so these checks work before ~/.ssh/config has the Include.
  vssh() { ssh -F "$HOME/.lima/$vm/ssh.config" -o BatchMode=yes "$host" "$@" </dev/null; }
  if ! vssh true 2>/dev/null; then
    bad "can't reach the VM over ssh" "limactl stop $vm && limactl start $vm"
    exit 1
  fi
  # Things that could push to GitHub or reach cloud accounts from inside the VM.
  found="$(vssh 'ls -d ~/.git-credentials ~/.config/gh/hosts.yml ~/.ssh/id_* ~/.aws ~/.config/gcloud 2>/dev/null' 2>/dev/null)"
  if [ -z "$found" ]; then ok "no Git, GitHub, SSH or cloud credentials in the VM"; else bad "credentials in the VM: $(echo $found)" "delete them in the VM; push from the Mac instead"; fi
  if vssh 'test -d ~/archestra/.git' 2>/dev/null; then ok "repo at ~/archestra in the VM"; else bad "no repo in the VM" "$dev_vm clone"; fi
else
  warn "VM is $status: skipped the in-VM checks ($dev_vm start)"
fi

exit "$failed"
