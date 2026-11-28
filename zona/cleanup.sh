#!/usr/bin/env bash
# zona's cleanup hook: runs in the VM copy's platform/ folder of a worktree
# whose Mac folder is gone, before zona removes the copy. Removes what the
# worktree's stack left outside the copy: its Kubernetes namespace (its
# database too) and its bridge.
set -uo pipefail

sudo systemctl disable --now -q "archestra-kind-bridge@${ZONA_PORT_9000}.service" 2>/dev/null || true
sudo systemctl reset-failed "archestra-kind-bridge@${ZONA_PORT_9000}.service" 2>/dev/null || true
kubectl --context kind-archestra delete namespace "archestra-dev-${ZONA_WORKTREE}" --ignore-not-found --wait=false
