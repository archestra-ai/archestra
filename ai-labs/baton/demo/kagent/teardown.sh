#!/usr/bin/env bash
# Tear down the kagent + baton-proxy demo.
#
# Deletes the kind cluster (which removes kagent, the agent, the fixture, and
# all secrets/configmaps in one shot). Pass --image to also remove the locally
# built proxy image.
#
# Prereqs: kind, docker (only if using --image).
set -euo pipefail

CLUSTER=baton-poc
IMAGE=baton-proxy:poc

remove_image=false
[[ "${1:-}" == "--image" ]] && remove_image=true

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "▸ deleting kind cluster $CLUSTER"
  kind delete cluster --name "$CLUSTER"
else
  echo "▸ no kind cluster named $CLUSTER — nothing to delete"
fi

if [[ "$remove_image" == true ]]; then
  echo "▸ removing image $IMAGE"
  docker image rm "$IMAGE" 2>/dev/null || echo "  (image not present)"
fi

echo "done"
