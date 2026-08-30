#!/usr/bin/env bash
# Deterministic front half of the archestra-dev-bench-analysis skill:
# resolve the run dir, run the Rust `prepare` subcommand, and shape everything
# the map workflow + doc assembly need. Run from anywhere (repo root is derived).
#
# Usage:  prepare.sh [run-dir]      # omit run-dir to pick the newest experiment
#
# Emits a `KEY=value` summary on stdout (the analyses/report doc paths included)
# plus the metrics block, and writes these files under <run-dir>/_prep_claude/:
#   manifest.json   raw `prepare` manifest
#   metrics.md      the metrics block (for doc assembly, step 4)
#   order.tsv       "idx<TAB>id<TAB>outcome", manifest order (for doc assembly)
#   prompts/NN.txt  one pre-rendered triage prompt per rollout (read by the map agents, not relayed)
#   map-args.json   ready-to-pass `args` for workflows/map.mjs (triageDir + promptsDir + rollouts[{idx,id}])
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPTS="$SKILL_DIR/reference/prompts.md"
ARG="${1:-}"

# Newest by mtime, restricted to timestamp-named dirs so `repro_*` reproduction
# dirs (which lexically sort after `2026…` and often have a null `outcome`) never win.
RUN_DIR="$(realpath "$( [ -n "$ARG" ] && echo "$ARG" \
  || ls -1dt "$ROOT"/ai-labs/experiments/[0-9]*/ | head -1 )")"
TS="$(date +%Y%m%d-%H%M%S)"
TRIAGE_DIR="$RUN_DIR/_triage_claude"
PREP="$RUN_DIR/_prep_claude"
# A fresh prepare starts a fresh analysis: clear old triage judgments, or a rerun would let
# render-triage.mjs silently consume stale <NN>.json files that happen to match the new order.tsv.
rm -rf "$TRIAGE_DIR"
mkdir -p "$TRIAGE_DIR" "$PREP"

# --- Rust prepare (deterministic render + metrics + manifest), fail-fast ---
MANIFEST="$PREP/manifest.json"
if ! cargo run -q --manifest-path "$ROOT/ai-labs/cli/Cargo.toml" -- \
       prepare --run-dir "$RUN_DIR" >"$MANIFEST" 2>"$PREP/prepare.err"; then
  echo "archestra-bench prepare failed:" >&2
  cat "$PREP/prepare.err" >&2
  exit 1
fi

# --- doc-assembly inputs ---
jq -r '.metrics_block' "$MANIFEST" >"$PREP/metrics.md"
jq -r '.rollouts | to_entries[] | "\(.key)\t\(.value.id)\t\(.value.outcome)"' \
  "$MANIFEST" >"$PREP/order.tsv"

# --- verbatim MAP prompt block from reference/prompts.md (the fenced block under "## MAP") ---
MAP_TEMPLATE="$(awk '/^## MAP/{f=1} f&&/^```$/{c++; if(c==1)next; if(c==2)exit} f&&c==1{print}' "$PROMPTS")"
if ! grep -qF '{ROLLOUT_ID}' <<<"$MAP_TEMPLATE" || ! grep -qF '{OUTCOME_SUMMARY}' <<<"$MAP_TEMPLATE" \
   || ! grep -qF '{TRAJECTORY_MD_PATH}' <<<"$MAP_TEMPLATE"; then
  echo "failed to extract the MAP prompt block from $PROMPTS (fence layout changed?)" >&2
  exit 1
fi

# --- pre-render one filled triage prompt per rollout, so the map args (and thus the
#     orchestrator's context) carry only tiny scalars, not the full manifest ---
PROMPTS_DIR="$PREP/prompts"
rm -rf "$PROMPTS_DIR"; mkdir -p "$PROMPTS_DIR"
N="$(jq '.rollouts | length' "$MANIFEST")"
for ((i=0; i<N; i++)); do
  id="$(jq -r ".rollouts[$i].id" "$MANIFEST")"
  os="$(jq -r ".rollouts[$i].outcome_summary" "$MANIFEST")"
  tm="$(jq -r ".rollouts[$i].trajectory_md" "$MANIFEST")"
  p="${MAP_TEMPLATE//\{ROLLOUT_ID\}/$id}"
  p="${p//\{OUTCOME_SUMMARY\}/$os}"
  p="${p//\{TRAJECTORY_MD_PATH\}/$tm}"
  printf '%s' "$p" >"$(printf '%s/%02d.txt' "$PROMPTS_DIR" "$i")"
done

# --- ready-to-pass args for workflows/map.mjs (small: the prompts live on disk) ---
jq -n --arg triageDir "$TRIAGE_DIR" --arg promptsDir "$PROMPTS_DIR" --slurpfile m "$MANIFEST" '{
  triageDir: $triageDir,
  promptsDir: $promptsDir,
  rollouts: ($m[0].rollouts | to_entries | map({ idx: .key, id: .value.id }))
}' >"$PREP/map-args.json"

cat <<EOF
RUN_DIR=$RUN_DIR
TS=$TS
TRIAGE_DIR=$TRIAGE_DIR
MANIFEST=$MANIFEST
METRICS=$PREP/metrics.md
ORDER=$PREP/order.tsv
MAP_ARGS=$PREP/map-args.json
ANALYSES_DOC=$RUN_DIR/trajectory_analyses_claude_$TS.md
REPORT_DOC=$RUN_DIR/trajectory_analysis_claude_$TS.md

--- metrics ---
EOF
cat "$PREP/metrics.md"
