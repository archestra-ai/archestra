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
#   map-args.json   ready-to-pass `args` for workflows/map.mjs (triageDir + mapTemplate + rollouts)
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROMPTS="$SKILL_DIR/reference/prompts.md"
ARG="${1:-}"

RUN_DIR="$(realpath "$( [ -n "$ARG" ] && echo "$ARG" \
  || ls -1d "$ROOT"/archestra-bench/experiments/*/ | sort | tail -1 )")"
TS="$(date +%Y%m%d-%H%M%S)"
TRIAGE_DIR="$RUN_DIR/_triage_claude"
PREP="$RUN_DIR/_prep_claude"
mkdir -p "$TRIAGE_DIR" "$PREP"

# --- Rust prepare (deterministic render + metrics + manifest), fail-fast ---
MANIFEST="$PREP/manifest.json"
if ! cargo run -q --manifest-path "$ROOT/archestra-bench/cli/Cargo.toml" -- \
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
if ! grep -qF '{ROLLOUT_ID}' <<<"$MAP_TEMPLATE" || ! grep -qF '{TRAJECTORY_MD_PATH}' <<<"$MAP_TEMPLATE"; then
  echo "failed to extract the MAP prompt block from $PROMPTS (fence layout changed?)" >&2
  exit 1
fi

# --- ready-to-pass args for workflows/map.mjs ---
jq -n --arg triageDir "$TRIAGE_DIR" --arg mapTemplate "$MAP_TEMPLATE" --slurpfile m "$MANIFEST" '{
  triageDir: $triageDir,
  mapTemplate: $mapTemplate,
  rollouts: ($m[0].rollouts | to_entries | map({
    idx: .key, id: .value.id, outcome: .value.outcome,
    outcomeSummary: .value.outcome_summary, trajectoryMd: .value.trajectory_md
  }))
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
