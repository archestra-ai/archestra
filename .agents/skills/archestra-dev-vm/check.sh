#!/usr/bin/env bash
# Checks the dev VM setup from the Mac: the VM's isolation settings, SSH
# access, the Mutagen sync of the checkout you run it in, and what the VM
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

# What your own ssh would do for the VM's name (Mutagen uses it).
ssh_settings="$(ssh -G "$host" 2>/dev/null)"
if echo "$ssh_settings" | grep -qx 'hostname 127.0.0.1'; then
  ok "ssh knows $host"
else
  bad "ssh doesn't know $host" "$dev_vm create (adds it to ~/.ssh/config)"
fi
if echo "$ssh_settings" | grep -qx 'forwardagent yes'; then
  bad "ssh would forward your agent to $host" "remove ForwardAgent yes for this host (or Host *) in ~/.ssh/config"
fi
if echo "$ssh_settings" | grep -q '^remoteforward '; then
  bad "ssh would forward Mac ports into the VM (RemoteForward)" "remove RemoteForward for this host (or Host *) in ~/.ssh/config"
fi

if ! command -v mutagen >/dev/null; then
  bad "Mutagen is not installed" "brew install mutagen-io/mutagen/mutagen"
elif ! top="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  bad "not inside a git repo" "run this from the Mac checkout you work in"
elif mutagen sync list "$(basename "$top")" >/dev/null 2>&1; then
  ok "$top is synced into the VM"
else
  bad "$top is not synced into the VM" "platform/scripts/dev-vm-sync.py start"
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
  echo "shares=$(mount | grep -cE " type (virtiofs|9p|fuse.sshfs) ")"
  echo "agent=${SSH_AUTH_SOCK:+yes}"
' </dev/null 2>/dev/null)" || { bad "can't reach the VM over ssh" "limactl stop $vm && limactl start $vm"; exit 1; }
value() { echo "$in_vm" | sed -n "s/^$1=//p"; }

if [ -z "$(value secrets)$(value helper)" ]; then
  ok "none of the checked credential places exist in the VM (git, gh, netrc, docker, SSH keys, aws, gcloud)"
else
  bad "credentials in the VM: $(value secrets)$(value helper)" "delete them in the VM; git and GitHub stay on the Mac"
fi
if [ "$(value shares)" = 0 ] && [ -z "$(value agent)" ]; then
  ok "inside the VM: no shared folder mounted, no SSH agent"
else
  bad "inside the VM: $(value shares) shared folder mount(s), SSH agent: $(value agent)" "recreate the VM with $dev_vm create"
fi

exit "$failed"
