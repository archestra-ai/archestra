#!/usr/bin/env bash
# Collects a support bundle for an Archestra Helm release into one tarball.
#
# Usage: support-bundle.sh <namespace> <release-name> [output-dir]
#
# Collects pods, restarts, events, the last 2h of logs per container (and the
# previous container, each capped in size), deployments and statefulsets, image
# versions, and an allowlisted subset of the Helm values. Container env values,
# commands and arguments, probe and hook header values, Secrets, ConfigMaps, and last-applied annotations are
# never collected. Logs are collected as written by the application, so review
# the bundle before sharing. Every kubectl call times out after
# KUBECTL_REQUEST_TIMEOUT (default 20s); a failed step leaves its error in the
# bundle and the rest is still collected.
#
# Requires kubectl, helm, jq, and tar.
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <namespace> <release-name> [output-dir]" >&2
  exit 2
fi

namespace="$1"
release="$2"
output_dir="${3:-.}"

for tool in kubectl helm jq tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is required" >&2
    exit 1
  fi
done

# Non-secret Helm values worth seeing, as jq paths. Everything else is dropped:
# archestra.env, secrets, credentials, and URLs never leave the cluster.
readonly HELM_VALUE_ALLOWLIST='[
  ["archestra", "replicaCount"],
  ["archestra", "image"],
  ["archestra", "resources"],
  ["archestra", "worker", "replicaCount"],
  ["archestra", "worker", "resources"],
  ["archestra", "database", "connectionBudget"],
  ["archestra", "deploymentStrategy"],
  ["archestra", "horizontalPodAutoscaler"],
  ["archestra", "podDisruptionBudget"],
  ["archestra", "codeRuntime", "enabled"],
  ["archestra", "diagnostics", "enabled"],
  ["archestra", "fileStorage", "provider"],
  ["archestra", "orchestrator", "kubernetes", "namespace"],
  ["archestra", "orchestrator", "kubernetes", "loadKubeconfigFromCurrentCluster"],
  ["archestra", "orchestrator", "kubernetes", "mcpServerRbac", "create"],
  ["archestra", "orchestrator", "kubernetes", "rbac", "create"],
  ["archestra", "orchestrator", "kubernetes", "rbac", "environmentNamespaces"],
  ["archestra", "sre"],
  ["postgresql", "enabled"]
]'

# Per container log file, for both the current and the previous container.
readonly LOG_LIMIT_BYTES=$((10 * 1024 * 1024))

# Drops container env values, commands and arguments (MCP server arguments can
# carry substituted credentials), exec probe and hook commands, HTTP probe and
# hook header values, and the annotations that can repeat them.
readonly SANITIZE='
  walk(
    if type == "object" then
      (if has("env") and (.env | type) == "array"
        then .env |= map(del(.value)) else . end)
      | (if has("httpHeaders") and (.httpHeaders | type) == "array"
        then .httpHeaders |= map(del(.value)) else . end)
      | (if has("image") and has("name") then del(.command, .args) else . end)
      | del(.exec)
      | del(.managedFields)
      | (if has("annotations") and (.annotations | type) == "object"
          then .annotations |= with_entries(select(.key | test("last-applied-configuration") | not))
          else . end)
    else . end
  )'

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
bundle_name="archestra-support-${release}-${timestamp}"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
bundle_dir="${work_dir}/${bundle_name}"
mkdir -p "${bundle_dir}/logs"

kubectl_timeout="${KUBECTL_REQUEST_TIMEOUT:-20s}"

kc() {
  kubectl --request-timeout="$kubectl_timeout" --namespace "$namespace" "$@"
}

echo "Collecting pods..." >&2
kc get pods -o wide >"${bundle_dir}/pods.txt" 2>&1 || true
pods_json="${work_dir}/pods.json"
if kc get pods -o json >"$pods_json" 2>"${bundle_dir}/pods.err"; then
  rm -f "${bundle_dir}/pods.err"
else
  echo '{"items": []}' >"$pods_json"
fi
jq "$SANITIZE" "$pods_json" >"${bundle_dir}/pods.json"

jq -r '
  ["POD", "CONTAINER", "RESTARTS", "READY", "LAST_TERMINATION_REASON", "LAST_EXIT_CODE"],
  (.items[] | .metadata.name as $pod
    | ((.status.initContainerStatuses // []) + (.status.containerStatuses // []))[]
    | [$pod, .name, (.restartCount | tostring), (.ready | tostring),
       (.lastState.terminated.reason // "-"),
       ((.lastState.terminated.exitCode // "-") | tostring)])
  | @tsv' "$pods_json" >"${bundle_dir}/restarts.tsv"

jq -r '
  ["POD", "CONTAINER", "IMAGE", "IMAGE_ID"],
  (.items[] | .metadata.name as $pod
    | ((.status.initContainerStatuses // []) + (.status.containerStatuses // []))[]
    | [$pod, .name, .image, (.imageID // "-")])
  | @tsv' "$pods_json" >"${bundle_dir}/images.tsv"

echo "Collecting events..." >&2
kc get events --sort-by=.lastTimestamp -o wide >"${bundle_dir}/events.txt" 2>&1 || true

echo "Collecting workloads..." >&2
for kind in deployments statefulsets; do
  kc get "$kind" -o wide >"${bundle_dir}/${kind}.txt" 2>&1 || true
  if kc get "$kind" -o json >"${work_dir}/${kind}.json" 2>/dev/null; then
    jq "$SANITIZE" "${work_dir}/${kind}.json" >"${bundle_dir}/${kind}.json"
  fi
done

echo "Collecting logs (last 2h)..." >&2
jq -r '
  .items[] | .metadata.name as $pod
  | ((.spec.initContainers // []) + (.spec.containers // []))[]
  | "\($pod) \(.name)"' "$pods_json" |
  while read -r pod container; do
    kc logs "$pod" -c "$container" --since=2h --limit-bytes="$LOG_LIMIT_BYTES" --timestamps \
      >"${bundle_dir}/logs/${pod}_${container}.log" 2>&1 || true
    if kc logs "$pod" -c "$container" --previous --since=2h \
      --limit-bytes="$LOG_LIMIT_BYTES" --timestamps \
      >"${bundle_dir}/logs/${pod}_${container}.previous.log" 2>/dev/null; then
      :
    else
      rm -f "${bundle_dir}/logs/${pod}_${container}.previous.log"
    fi
  done

echo "Collecting allowlisted Helm values..." >&2
if helm get values "$release" --namespace "$namespace" --all -o json \
  >"${work_dir}/values.json" 2>"${bundle_dir}/helm-values.err"; then
  jq --argjson allow "$HELM_VALUE_ALLOWLIST" '
    . as $values
    | reduce $allow[] as $path ({};
        ($values | getpath($path)) as $value
        | if $value == null then . else setpath($path; $value) end)' \
    "${work_dir}/values.json" >"${bundle_dir}/helm-values.json"
  rm -f "${bundle_dir}/helm-values.err"
fi
helm list --namespace "$namespace" --filter "^${release}\$" \
  >"${bundle_dir}/helm-release.txt" 2>&1 || true

kubectl --request-timeout="$kubectl_timeout" version -o json >"${bundle_dir}/kubectl-version.json" 2>&1 || true

archive="${output_dir%/}/${bundle_name}.tar.gz"
tar -czf "$archive" -C "$work_dir" "$bundle_name"
echo "$archive"
