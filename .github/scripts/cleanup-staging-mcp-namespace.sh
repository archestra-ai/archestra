#!/usr/bin/env bash
# One-off cleanup after staging moved its runtime workloads from `archestra`
# to `archestra-mcp` (archestra.orchestrator.kubernetes.namespace in
# .github/values-staging.yaml).
#
# On startup the platform recreates every MCP server, warm pool, image
# pre-puller and Dagger engine in the new namespace, but its orphan sweeps only
# look at the namespaces it now resolves to, so the copies in `archestra` stay:
# running pods, their Services, their credential Secrets and NetworkPolicies.
# This deletes those copies. It leaves alone:
#   - the platform release itself (Helm-managed);
#   - Agent Runtime sessions started before the move (agent-run-*,
#     claude-account-*, runner-*, and warm pods already claimed by a run): the
#     platform stored their namespace and still releases them there;
#   - anything Terraform or a person created (lobster-env reader, bench, ...).
#
# Run it only after the deploy with the new namespace has fully rolled out:
# until then, old platform pods still serve from the `archestra` copies.
#
# Dry run by default; pass --apply to delete.
#
#   .github/scripts/cleanup-staging-mcp-namespace.sh [--apply] [--context CTX]
set -euo pipefail

old_ns=archestra
new_ns=archestra-mcp
release=archestra-platform
apply=false
context=gke_friendly-path-465518-r6_us-central1-a_archestra-staging

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) apply=true ;;
    --context) context="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

k() { kubectl --context "$context" "$@"; }

# --- Preflight: the platform must already run against the new namespace -----
for deploy in "$release" "$release-worker"; do
  configured=$(k -n "$old_ns" get deployment "$deploy" -o json |
    jq -r '.spec.template.spec.containers[0].env[] | select(.name == "ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE") | .value')
  if [[ "$configured" != "$new_ns" ]]; then
    echo "$deploy is configured for namespace '$configured', not '$new_ns'. Deploy first." >&2
    exit 1
  fi
  k -n "$old_ns" rollout status "deployment/$deploy" --timeout=10s >/dev/null || {
    echo "$deploy has not finished rolling out; old pods may still use $old_ns." >&2
    exit 1
  }
done

# --- MCP servers -------------------------------------------------------------
# Delete an old copy only when the platform has recreated that server in the
# new namespace. A server whose redeploy failed is reported and kept, so its
# old copy is still there to inspect.
moved_ids=$(k -n "$new_ns" get deployments -l app=mcp-server -o json |
  jq -r '.items[].metadata.labels["mcp-server-id"] // empty' | sort -u)
mcp_deployments=()
kept_deployments=()
while read -r name id; do
  [[ -z "$name" ]] && continue
  if [[ -n "$id" ]] && grep -qx "$id" <<<"$moved_ids"; then
    mcp_deployments+=("$name")
  else
    kept_deployments+=("$name")
    echo "KEEP deployment/$name: server '$id' has no deployment in $new_ns yet"
  fi
done < <(k -n "$old_ns" get deployments -l app=mcp-server -o json |
  jq -r '.items[] | "\(.metadata.name) \(.metadata.labels["mcp-server-id"] // "")"')

# --- Warm pools ----------------------------------------------------------------
# Deleting a pool deletes the sandboxes it still owns. A claimed warm pod keeps
# its pool-style name but gains the agent-run-task-id label; never delete a pool
# that still owns one.
warm_pools=()
kept_pools=0
claimed=$(k -n "$old_ns" get sandboxes.agents.x-k8s.io -l archestra.io/agent-run-task-id -o json |
  jq -r '.items[].metadata.ownerReferences[]? | select(.kind == "SandboxWarmPool") | .name' | sort -u)
for pool in $(k -n "$old_ns" get sandboxwarmpools.extensions.agents.x-k8s.io -l archestra.io/purpose=agent-warm-pool -o name); do
  if grep -qx "${pool##*/}" <<<"$claimed"; then
    echo "KEEP $pool: owns a sandbox claimed by a run"
    kept_pools=$((kept_pools + 1))
  else
    warm_pools+=("$pool")
  fi
done

# --- Plan ----------------------------------------------------------------------
plan=()
for d in "${mcp_deployments[@]+"${mcp_deployments[@]}"}"; do
  plan+=("deployment/$d")
done
add_selected() { # kind selector
  local obj
  while read -r obj; do
    if [[ -n "$obj" ]]; then plan+=("$obj"); fi
  done < <(k -n "$old_ns" get "$1" -l "$2" -o name)
}
# What a kept deployment still uses: its Service, egress policy and every
# Secret it references. Everything else the platform labelled app=mcp-server
# goes: it is re-created from the database in the new namespace, or belonged
# to a server uninstalled long ago.
keep=""
if [[ ${#kept_deployments[@]} -gt 0 ]]; then
  keep=$(k -n "$old_ns" get deployments "${kept_deployments[@]}" -o json | jq -r '
    .items[]
    | "service/\(.metadata.name)-service",
      "networkpolicy.networking.k8s.io/mcp-egress-\(.metadata.name)",
      (.spec.template.spec
        | ([.containers[]?, .initContainers[]?]
            | map((.envFrom[]?.secretRef.name // empty),
                  (.env[]?.valueFrom.secretKeyRef.name // empty))
            | .[]),
          (.volumes[]?.secret.secretName // empty),
          (.imagePullSecrets[]?.name // empty)
        | "secret/\(.)")')
fi
for kind in services secrets networkpolicies; do
  while read -r obj; do
    if [[ -n "$obj" ]] && ! grep -qx "$obj" <<<"$keep"; then plan+=("$obj"); fi
  done < <(k -n "$old_ns" get "$kind" -l app=mcp-server -o name)
done
if [[ ${#kept_deployments[@]} -eq 0 ]]; then
  add_selected networkpolicies archestra.io/resource=mcp-egress-baseline
fi
add_selected daemonsets app.kubernetes.io/component=mcp-image-prepuller
add_selected daemonsets app.kubernetes.io/component=agent-image-prefetch
plan+=("${warm_pools[@]+"${warm_pools[@]}"}")
# Templates only once no pool is left that could still use one.
if [[ $kept_pools -eq 0 ]]; then
  add_selected sandboxtemplates.extensions.agents.x-k8s.io archestra.io/purpose=agent-warm-pool
fi
# Code-runtime Dagger engines: privileged StatefulSets with rebuildable caches.
add_selected statefulsets app=dagger-engine
add_selected configmaps app=dagger-engine
add_selected persistentvolumeclaims app=dagger-engine
add_selected networkpolicies archestra.io/resource=dagger-egress-policy

final=("${plan[@]+"${plan[@]}"}")

if [[ ${#final[@]} -eq 0 ]]; then
  echo "Nothing to clean up in $old_ns."
  exit 0
fi

printf '%s\n' "${final[@]}" | sort -u | sed "s|^|DELETE -n $old_ns |"
echo "${#final[@]} objects."

if [[ "$apply" != true ]]; then
  echo "Dry run. Re-run with --apply to delete."
  exit 0
fi

printf '%s\n' "${final[@]}" | sort -u | xargs -n 20 kubectl --context "$context" -n "$old_ns" delete --ignore-not-found --wait=false
