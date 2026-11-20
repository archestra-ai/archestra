"""Make release/X.Y the one supported release line.

Rewrites .github/backport-targets.json, which backports, the nightly release
image scan and the client-version updates read, and every Dependabot
`target-branch`, which Dependabot reads only from main's dependabot.yml. The
previous line then gets no more automated updates.

    python3 .github/scripts/set-release-line.py release/1.5

move-release-line.yml runs it when a stable X.Y.0 is published.
"""
import json
import re
import sys
from pathlib import Path

LINE = re.compile(r"release/[0-9]+\.[0-9]+")
TARGET_BRANCH = re.compile(r"(?m)^(    target-branch: )release/[0-9]+\.[0-9]+$")


def main(argv):
    if len(argv) != 2 or not LINE.fullmatch(argv[1]):
        raise SystemExit("usage: set-release-line.py release/X.Y")
    line = argv[1]
    root = Path(__file__).resolve().parents[2]
    targets = root / ".github/backport-targets.json"
    targets.write_text(f'{{\n  "branches": {json.dumps([line])}\n}}\n')
    dependabot = root / ".github/dependabot.yml"
    text, count = TARGET_BRANCH.subn(rf"\g<1>{line}", dependabot.read_text())
    if not count:
        raise SystemExit("dependabot.yml has no release-line entries to move")
    dependabot.write_text(text)
    print(f"{line} is the supported release line ({count} Dependabot entries)")


if __name__ == "__main__":
    main(sys.argv)
