#!/usr/bin/env bash
# Find pnpm overrides that are now redundant — i.e. the dependency graph already
# resolves to a compliant version without them, so they can be removed.
#
# READ-ONLY: snapshots pnpm-workspace.yaml + pnpm-lock.yaml, strips the overrides
# block, re-resolves to get the *natural* versions, compares each override against
# that, then ALWAYS restores both files (even on error/interrupt). Nothing is left
# modified and nothing is committed.
#
# Usage:  find-redundant-overrides.sh            # report all overrides
#         find-redundant-overrides.sh --json     # machine-readable
set -euo pipefail

JSON=0; [ "${1:-}" = "--json" ] && JSON=1
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT/platform"
WS=pnpm-workspace.yaml; LK=pnpm-lock.yaml
BK="$(mktemp -d)"
cp "$WS" "$BK/ws"; cp "$LK" "$BK/lock"
restore() { cp "$BK/ws" "$WS"; cp "$BK/lock" "$LK"; rm -rf "$BK"; }
trap restore EXIT INT TERM

# 1) capture the overrides (key<TAB>value) before stripping
python3 - "$WS" > "$BK/overrides.tsv" <<'PY'
import re, sys
inb=False
for ln in open(sys.argv[1]):
    if re.match(r'^overrides:', ln): inb=True; continue
    if inb and re.match(r'^[A-Za-z]', ln): break       # next top-level key
    if not inb: continue
    s=ln.rstrip("\n")
    if not s.strip() or s.strip().startswith('#'): continue
    k,_,v=s.strip().partition(':')
    print(f"{k.strip().strip(chr(39)+chr(34))}\t{v.strip().strip(chr(39)+chr(34))}")
PY

# 2) strip the overrides block
python3 - "$WS" <<'PY'
import re, sys
p=sys.argv[1]; out=[]; skip=False
for ln in open(p):
    if re.match(r'^overrides:', ln): skip=True; continue
    if skip and re.match(r'^[A-Za-z]', ln): skip=False
    if not skip: out.append(ln)
open(p,'w').writelines(out)
PY

# 3) natural re-resolution (no overrides)
if ! corepack pnpm install --lockfile-only --ignore-scripts >"$BK/install.log" 2>&1; then
  echo "ERROR: natural re-resolution failed (see below) — overrides left in place." >&2
  tail -15 "$BK/install.log" >&2
  exit 1
fi

# 4) compare each override against the natural lockfile
python3 - "$BK/overrides.tsv" "$LK" "$WS" "$JSON" <<'PY'
import re, sys, json

ov_path, lock_path, ws_path, as_json = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]=="1"

# collect resolved versions per package from the natural lockfile
vers = {}
pat = re.compile(r"^\s+'?((?:@[^/]+/)?[A-Za-z0-9._-]+)@([0-9][^()'\s:]*)'?:")
for ln in open(lock_path):
    m = pat.match(ln)
    if m:
        vers.setdefault(m.group(1), set()).add(m.group(2))

# packages in minimumReleaseAgeExclude belong to Mode A (their natural resolution is
# confounded by the exclusion) — defer rather than call them redundant here.
excluded=set(); inx=False
for ln in open(ws_path):
    if re.match(r'^minimumReleaseAgeExclude:', ln): inx=True; continue
    if inx and re.match(r'^[A-Za-z]', ln): break
    if inx:
        m=re.match(r'\s*-\s*"?([^"\s]+)"?', ln)
        if m: excluded.add(m.group(1).replace('/*',''))

def vt(v):
    v = re.split(r'[-+]', v)[0]
    nums = re.findall(r'\d+', v)
    return tuple(int(x) for x in (nums[:3] + ['0','0','0'])[:3])

def satisfies(v, rng):
    """True if version v satisfies a simple range (>=,>,<=,<,^,~,exact)."""
    rng = rng.strip()
    a = vt(v)
    if rng.startswith('>='): return a >= vt(rng[2:])
    if rng.startswith('<='): return a <= vt(rng[2:])
    if rng.startswith('>'):  return a >  vt(rng[1:])
    if rng.startswith('<'):  return a <  vt(rng[1:])
    if rng.startswith('^'):
        b = vt(rng[1:]);  return a >= b and a[0] == b[0]
    if rng.startswith('~'):
        b = vt(rng[1:]);  return a >= b and a[:2] == b[:2]
    return a == vt(rng)  # exact

def parse_key(k):
    if '>' in k and '@>' not in k and '@<' not in k:        # nested parent>child
        parent, _, child = k.partition('>')
        return ('nested', child.strip(), None)
    m = re.match(r'^(@?[\w./-]+?)@([<>=^~].*|\d.*)$', k)     # name@<selector>
    if m and not (k.startswith('@') and k.count('@') == 1):
        return ('scoped', m.group(1), m.group(2))
    return ('plain', k, None)

def floor_of(val):
    val = val.strip()
    if val.startswith('>='): return vt(val[2:])
    if val[:1] in ('>','^','~'): return vt(val[1:])
    if re.match(r'^\d', val): return vt(val)   # exact
    return None

rows=[]
for line in open(ov_path):
    if not line.strip(): continue
    key, val = line.rstrip("\n").split("\t")
    kind, name, selector = parse_key(key)
    all_nat = sorted(vers.get(name, []), key=vt)
    # only the instances this override actually targets
    scoped_nat = [x for x in all_nat if satisfies(x, selector)] if selector else all_nat
    is_exact = bool(re.match(r'^\d', val.strip()))
    floor = floor_of(val)

    if name in excluded:
        verdict, why = "DEFER", "in minimumReleaseAgeExclude — handle via Mode A once matured"
    elif not all_nat:
        verdict, why = "REMOVABLE?", "package no longer in tree (override likely dead)"
    elif selector and not scoped_nat:
        verdict, why = "REDUNDANT", f"no natural version matches selector '{selector}'"
    elif floor is None:
        verdict, why = "REVIEW", f"non-version target {val!r}"
    elif is_exact:
        if set(scoped_nat) == {val}:
            verdict, why = "REDUNDANT", f"natural (in scope) already == {val}"
        elif all(vt(x) >= floor for x in scoped_nat):
            verdict, why = "REVIEW", f"exact pin holds at {val}; natural would float to {scoped_nat[-1]}"
        else:
            verdict, why = "KEEP", f"natural {[x for x in scoped_nat if vt(x)<floor]} below {val}"
    else:  # floor (>=)
        if all(vt(x) >= floor for x in scoped_nat):
            verdict, why = "REDUNDANT", f"in-scope natural {scoped_nat} all satisfy {val}"
        else:
            verdict, why = "KEEP", f"in-scope natural {[x for x in scoped_nat if vt(x)<floor]} below {val}"
    rows.append(dict(override=f"{key}: {val}", package=name, kind=kind,
                     natural=scoped_nat if selector else all_nat, verdict=verdict, why=why))

if as_json:
    print(json.dumps(rows, indent=2)); sys.exit(0)

order={"REDUNDANT":0,"REMOVABLE?":1,"REVIEW":2,"DEFER":3,"KEEP":4}
rows.sort(key=lambda r: order.get(r["verdict"],9))
for v in ("REDUNDANT","REMOVABLE?","REVIEW","DEFER","KEEP"):
    grp=[r for r in rows if r["verdict"]==v]
    if not grp: continue
    print(f"\n## {v} ({len(grp)})")
    for r in grp:
        nat = ",".join(r["natural"]) or "—"
        print(f"  {r['override']:<42} natural=[{nat}]  — {r['why']}")
print(f"\nTotal overrides: {len(rows)} | "
      + " | ".join(f"{v}:{sum(1 for r in rows if r['verdict']==v)}" for v in order))
PY
