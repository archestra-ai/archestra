#!/usr/bin/env bash
# Incrementally remove redundant pnpm overrides, ONE AT A TIME, keeping only those
# whose removal leaves the resolved dependency tree byte-identical. Net-positive by
# design: a removal that shifts resolution (or introduces a CVE) is reverted and the
# rest are left untouched. Defaults to one removal per run (--limit 1) so each lands
# in its own small, trivially-revertible PR; re-run for the next.
#
# Why one-at-a-time: removing N overrides at once and diffing the lockfile is all-or-
# nothing — a single load-bearing override makes the whole batch look unsafe. Per-
# package isolation proves each removal independently and auto-handles interaction
# false-positives (e.g. nested overrides that only look redundant once a sibling
# floor is also stripped).
#
# Usage:
#   sweep-redundant-overrides.sh [--limit N] [--skip key1,key2,...] [--dry-run]
#     --limit N    stop after N successful removals (default 1 — one removal per PR)
#     --skip ...   override keys to leave alone (e.g. recently-added CVE floors)
#     --dry-run    report what would be removed; restore the tree at the end
#
# On success the working tree is left with the verified removals applied (lockfile
# re-resolved). On any error/interrupt the tree is restored to its starting state.
set -euo pipefail

LIMIT=1; SKIP=","; DRYRUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2;;
    --skip)  SKIP=",$2,"; shift 2;;
    --dry-run) DRYRUN=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$(git rev-parse --show-toplevel)/platform"

WS=pnpm-workspace.yaml; LOCK=pnpm-lock.yaml
START_WS="$(mktemp)"; START_LOCK="$(mktemp)"
cp "$WS" "$START_WS"; cp "$LOCK" "$START_LOCK"
restore_all() { cp "$START_WS" "$WS"; cp "$START_LOCK" "$LOCK"; }
trap 'echo "interrupted — restoring tree" >&2; restore_all; exit 1' INT TERM ERR

# Resolution fingerprint: the lockfile minus the overrides metadata block and minus
# `specifier:` lines (which merely reflect the override value vs the declared range).
# Two fingerprints match iff every resolved version is identical.
fingerprint() {
  awk '/^overrides:$/{s=1;next} s&&/^[A-Za-z]/{s=0} !s{print}' "$LOCK" \
    | grep -vE '^[[:space:]]*specifier:' | sha256sum | cut -d' ' -f1
}

# Delete the override line for $1 (plus any comment lines directly above it) from $WS.
remove_override() {
  local key="$1"
  local range
  range="$(awk -v key="$key" '
    { a[NR]=$0; n=NR }
    END{
      inov=0; ovstart=0; hit=0
      for(i=1;i<=n;i++){
        l=a[i]
        if(l ~ /^overrides:$/){inov=1; ovstart=i; continue}
        if(inov && l ~ /^[A-Za-z]/){inov=0}
        if(!inov) continue
        t=l; sub(/^[ \t]+/,"",t)
        if(t ~ /^#/) continue
        idx=index(t,": "); if(idx==0) continue
        k=substr(t,1,idx-1); gsub(/^'\''|'\''$/,"",k)
        if(k==key){ hit=i; break }
      }
      if(!hit){ print "0 0"; exit }
      start=hit; j=hit-1
      while(j>ovstart){ t=a[j]; sub(/^[ \t]+/,"",t); if(t ~ /^#/){start=j; j--} else break }
      print start" "hit
    }' "$WS")"
  local s="${range%% *}" e="${range##* }"
  [ "$s" = "0" ] && return 1
  sed -i "${s},${e}d" "$WS"
  return 0
}

candidates() {
  bash "$SKILL_DIR/scripts/find-redundant-overrides.sh" 2>/dev/null \
    | awk '/^## REDUNDANT/{f=1;next} /^## /{f=0} f && /^  / { t=$0; sub(/^  /,"",t); idx=index(t,": "); if(idx>0) print substr(t,1,idx-1) }'
}

echo "Capturing baseline (resolution fingerprint + CVE set)…"
BASE_FP="$(fingerprint)"
bash "$SKILL_DIR/scripts/audit-guard.sh" baseline /tmp/cve-before.txt >/dev/null

mapfile -t CANDS < <(candidates)
echo "Redundant candidates: ${#CANDS[@]} | limit: $LIMIT"
swept=(); skipped_lb=(); skipped_policy=()

for key in "${CANDS[@]}"; do
  [ "${#swept[@]}" -ge "$LIMIT" ] && break
  case "$SKIP" in *",$key,"*) skipped_policy+=("$key"); continue;; esac

  cp "$WS" /tmp/iter-ws; cp "$LOCK" /tmp/iter-lock
  if ! remove_override "$key"; then continue; fi
  if ! corepack pnpm install --lockfile-only --ignore-scripts >/dev/null 2>&1 \
     || [ "$(fingerprint)" != "$BASE_FP" ] \
     || ! bash "$SKILL_DIR/scripts/audit-guard.sh" check /tmp/cve-before.txt >/dev/null 2>&1; then
    cp /tmp/iter-ws "$WS"; cp /tmp/iter-lock "$LOCK"   # revert this one, keep the rest
    skipped_lb+=("$key")
  else
    swept+=("$key")
    echo "  ✓ swept $key"
  fi
done

echo
echo "SWEPT (${#swept[@]}): ${swept[*]:-none}"
[ "${#skipped_lb[@]}" -gt 0 ]     && echo "LEFT — load-bearing (${#skipped_lb[@]}): ${skipped_lb[*]}"
[ "${#skipped_policy[@]}" -gt 0 ] && echo "LEFT — --skip policy (${#skipped_policy[@]}): ${skipped_policy[*]}"
[ "${#CANDS[@]}" -gt "$LIMIT" ]   && echo "Note: stopped at --limit $LIMIT; more candidates remain for a follow-up run."

if [ "$DRYRUN" = "1" ]; then echo "(dry-run) restoring tree"; restore_all; fi
trap - INT TERM ERR
