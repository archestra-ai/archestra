#!/usr/bin/env python3
"""Fail a stable feature release (X.Y.0) that has no upgrade guide for it.

Every new stable line ships a docs page telling operators how to upgrade from the
previous line: docs/pages/admin/upgrade-v<A>-<B>-to-v<X>-<Y>.md, on release/X.Y.
Patch releases, release candidates, and betas pass. Run from the repository root.
"""

import json
import re
import sys
from pathlib import Path

MANIFEST = Path(".github/release-please/.release-please-manifest.json")
GUIDES = Path("docs/pages/admin")


def main() -> int:
    version = json.loads(MANIFEST.read_text())["platform"]
    match = re.fullmatch(r"(\d+)\.(\d+)\.0", version)
    if not match:
        print(f"{version} is not a new stable line; no upgrade guide needed.")
        return 0

    major, minor = match.groups()
    pattern = f"upgrade-v*-to-v{major}-{minor}.md"
    guides = sorted(GUIDES.glob(pattern))
    if guides:
        print(f"Upgrade guide for {version}: {guides[0]}")
        return 0

    print(
        f"::error::{version} starts a new stable line but has no upgrade guide. "
        f"Add {GUIDES}/{pattern.replace('*', '<previous major>-<previous minor>')} to release/{major}.{minor} "
        "before merging this release PR. Write it with the archestra-upgrade-guide skill (platform/dev/RELEASE.md, Write The Upgrade Guide)."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
