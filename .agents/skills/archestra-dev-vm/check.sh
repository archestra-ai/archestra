#!/usr/bin/env bash
# Checks the dev VM setup from the Mac: the VM's isolation settings, SSH
# access, the "vm" git remote of the repo you run it in, and what the VM
# holds. Read-only; prints a fix for each failed check and exits non-zero if
# any check failed or could not run.
# Usage: check.sh  (env ARCHESTRA_DEV_VM, default archestra-dev)
set -uo pipefail

vm="${ARCHESTRA_DEV_VM:-archestra-dev}"
host="lima-$vm"
dev_vm="platform/scripts/dev-vm.sh"
failed=0
ok() { echo "✅ $*"; }
bad() { echo "❌ $1"; echo "   fix: $2"; failed=1; }

command -v limactl >/dev/null || { bad "Lima is not installed" "brew install lima"; exit 1; }
# One JSON line with the settings Lima uses for the VM.
config="$(limactl list --json "$vm" 2>/dev/null)"
[ -n "$config" ] || { bad "no VM named $vm" "$dev_vm create"; exit 1; }

case "$config" in
  *'"mounts":[{'*) bad "the VM mounts Mac folders" "set 'mounts: []' (limactl edit $vm), or recreate it with $dev_vm create" ;;
  *) ok "no Mac folders mounted" ;;
esac
case "$config" in
  *'"forwardAgent":false'*) ok "Lima does not forward the SSH agent" ;;
  *) bad "Lima's SSH agent forwarding is not off" "set ssh.forwardAgent: false (limactl edit $vm)" ;;
esac
case "$config" in
  *'"hostLoopback":false'*) ok "Mac localhost blocked (networkOpts.hostLoopback: false)" ;;
  *) bad "the VM can reach the Mac's localhost" "limactl stop $vm && limactl edit --tty=false $vm --set '.networkOpts.hostLoopback = false' && limactl start $vm" ;;
esac

# What your own ssh would do for the VM's name (git fetch vm, editors).
ssh_settings="$(ssh -G "$host" 2>/dev/null)"
if echo "$ssh_settings" | grep -qx 'hostname 127.0.0.1'; then
  ok "ssh knows $host"
else
  bad "ssh doesn't know $host" "add the lines from '$dev_vm ssh-config' to the top of ~/.ssh/config"
fi
if echo "$ssh_settings" | grep -qx 'forwardagent yes'; then
  bad "ssh would forward your agent to $host" "remove ForwardAgent yes for this host (or Host *) in ~/.ssh/config"
fi
if echo "$ssh_settings" | grep -q '^remoteforward '; then
  bad "ssh would forward Mac ports into the VM (RemoteForward)" "remove RemoteForward for this host (or Host *) in ~/.ssh/config"
fi

if top="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  if [ "$(git -C "$top" remote get-url vm 2>/dev/null)" = "$host:archestra" ]; then
    ok "git remote vm in $top"
  else
    bad "no git remote vm -> $host:archestra in $top" "$dev_vm remote"
  fi
else
  bad "not inside a git repo" "run this from the Mac checkout you push from"
fi

case "$config" in
  *'"status":"Running"'*) ;;
  *) bad "the VM is not running, so its contents were not checked" "$dev_vm start"; exit 1 ;;
esac
# One round trip, over Lima's own ssh config so it works before ~/.ssh/config
# has the Include. Each line is name=value.
in_vm="$(ssh -F "$HOME/.lima/$vm/ssh.config" -o BatchMode=yes "$host" '
  echo "secrets=$(ls -d ~/.git-credentials ~/.netrc ~/.config/gh/hosts.yml ~/.docker/config.json ~/.ssh/id_* ~/.aws ~/.config/gcloud 2>/dev/null | tr "\n" " ")"
  echo "helper=$(git config --global credential.helper)"
  echo "repo=$(test -d ~/archestra/.git && echo yes)"
  echo "remotes=$(git -C ~/archestra remote 2>/dev/null | tr "\n" " ")"
  echo "shares=$(mount | grep -cE " type (virtiofs|9p|fuse.sshfs) ")"
  echo "agent=${SSH_AUTH_SOCK:+yes}"
' </dev/null 2>/dev/null)" || { bad "can't reach the VM over ssh" "limactl stop $vm && limactl start $vm"; exit 1; }
value() { echo "$in_vm" | sed -n "s/^$1=//p"; }

if [ -z "$(value secrets)$(value helper)" ]; then
  ok "none of the checked credential places exist in the VM (git, gh, netrc, docker, SSH keys, aws, gcloud)"
else
  bad "credentials in the VM: $(value secrets)$(value helper)" "delete them in the VM; push from the Mac instead"
fi
if [ "$(value shares)" = 0 ] && [ -z "$(value agent)" ]; then
  ok "inside the VM: no shared folder mounted, no SSH agent"
else
  bad "inside the VM: $(value shares) shared folder mount(s), SSH agent: $(value agent)" "recreate the VM with $dev_vm create"
fi
if [ "$(value repo)" != yes ]; then
  bad "no repo at ~/archestra in the VM" "$dev_vm create"
elif [ -n "$(value remotes)" ]; then
  bad "the VM's repo has remotes: $(value remotes)" "git -C ~/archestra remote remove <name> in the VM; use $dev_vm push"
else
  ok "the VM's repo has no remotes (code comes only from the Mac)"
fi

exit "$failed"
