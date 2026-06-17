#!/usr/bin/env bash
# Guard against introducing new HIGH/CRITICAL npm CVEs during an override sweep.
# Snapshots the high/critical advisory set from `pnpm audit` before a change, then
# after re-resolving asserts the set did NOT grow.
#
# Mirrors the merge-queue Docker scan's npm-package findings but does NOT see
# base-image OS-package CVEs — the CI Docker scan remains the authoritative gate.
# Scans all deps (not just --prod): the guard checks the new-advisory delta, so
# dev/build-tool CVEs (vite, esbuild, rollup, …) are caught too, while pre-existing
# ones sit in the baseline and don't trip it.
#
# Usage:
#   audit-guard.sh baseline <file>   # capture current high/critical set to <file>
#   audit-guard.sh check <file>      # compare current set vs <file>; exit 1 if any NEW
set -euo pipefail

cmd="${1:-}"; file="${2:-}"
if [ -z "$cmd" ] || [ -z "$file" ]; then
  echo "usage: audit-guard.sh {baseline|check} <file>" >&2; exit 2
fi
cd "$(git rev-parse --show-toplevel)/platform"

# Print the current high/critical advisory set, one stable key per line, sorted.
current() {
  local raw
  raw="$(corepack pnpm audit --json 2>/dev/null || true)"   # audit exits nonzero when vulns exist
  if ! jq -e '.metadata' >/dev/null 2>&1 <<<"$raw"; then
    echo "ERROR: pnpm audit produced no valid JSON (network/registry issue?)" >&2
    return 3
  fi
  jq -r '.advisories[]? | select(.severity=="high" or .severity=="critical")
         | "\(.severity)\t\(.module_name)\t\(.github_advisory_id // .url)"' <<<"$raw" | sort -u
}

case "$cmd" in
  baseline)
    current > "$file"
    echo "baseline: $(wc -l < "$file" | tr -d ' ') high/critical advisories → $file"
    ;;
  check)
    [ -f "$file" ] || { echo "ERROR: baseline file $file not found — run 'baseline' first." >&2; exit 2; }
    cur="$(mktemp)"; current > "$cur"
    new="$(comm -13 "$file" "$cur")"     # present now, absent in baseline
    gone="$(comm -23 "$file" "$cur")"    # present in baseline, gone now (the sweep's wins)
    if [ -n "$new" ]; then
      echo "FAIL — the sweep introduced new HIGH/CRITICAL advisories:"
      echo "$new" | sed 's/^/  + /'
      rm -f "$cur"; exit 1
    fi
    echo "OK — no new high/critical advisories (baseline $(wc -l < "$file" | tr -d ' ') → now $(wc -l < "$cur" | tr -d ' '))."
    [ -n "$gone" ] && { echo "cleared by the sweep:"; echo "$gone" | sed 's/^/  - /'; }
    rm -f "$cur"
    ;;
  *)
    echo "unknown command: $cmd (use baseline|check)" >&2; exit 2 ;;
esac
