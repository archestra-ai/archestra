#!/usr/bin/env python3
"""Check whether npm package versions have cleared the minimumReleaseAge window.

Usage:
    maturity.py [--days N] <pkg>@<version> [<pkg>@<version> ...]

Exit code 0 = all given versions are MATURE (safe to un-pin / un-exclude),
1 = at least one is still QUARANTINED, 2 = a version is unpublished / bad input.
"""
import sys
import json
import subprocess
from datetime import datetime, timezone, timedelta

args = sys.argv[1:]
days = 7  # mirrors pnpm-workspace.yaml `minimumReleaseAge: 10080` (minutes)
if len(args) >= 2 and args[0] == "--days":
    days = int(args[1])
    args = args[2:]

if not args:
    print("usage: maturity.py [--days N] pkg@version [pkg@version ...]")
    sys.exit(2)

now = datetime.now(timezone.utc)
cutoff = now - timedelta(days=days)
rc = 0

for spec in args:
    name, _, ver = spec.rpartition("@")
    if not name or not ver:
        print(f"{spec}: bad spec — use pkg@version (e.g. form-data@3.0.5)")
        rc = 2
        continue
    out = subprocess.run(
        ["npm", "view", name, "time", "--json"],
        capture_output=True, text=True,
    ).stdout
    times = json.loads(out) if out.strip() else {}
    published = times.get(ver)
    if not published:
        print(f"{name}@{ver}: NOT PUBLISHED on npm")
        rc = 2
        continue
    dt = datetime.fromisoformat(published.replace("Z", "+00:00"))
    if dt <= cutoff:
        age = (now - dt).days
        print(f"{name}@{ver}: MATURE (published {published[:10]}, age {age}d) — safe to sweep")
    else:
        clears = dt + timedelta(days=days)
        hrs = round((clears - now).total_seconds() / 3600, 1)
        print(f"{name}@{ver}: QUARANTINED (published {published[:10]}) — clears {clears.date()} (~{hrs}h)")
        rc = max(rc, 1)

sys.exit(rc)
