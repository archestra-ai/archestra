"""Make release/X.Y the one supported release line.

Rewrites .github/backport-targets.json, which backports, the nightly release
image scan and the client-version updates read, and every Dependabot
`target-branch`, which Dependabot reads only from main's dependabot.yml. The
previous line then gets no more automated updates.

    python3 .github/scripts/set-release-line.py release/1.5

move-release-line.yml runs it when a stable X.Y.0 is published. A line cut
from main already has its own Dependabot entries (stable-line.py cut adds them
with `add_line`, so the new line gets updates before its X.Y.0); then the
other lines' entries are removed instead of moved.
"""
import json
import re
import sys
from pathlib import Path

LINE = re.compile(r"release/[0-9]+\.[0-9]+")
TARGET_BRANCH = re.compile(r"(?m)^    target-branch: (release/[0-9]+\.[0-9]+)$")


def entries(text):
    """The (start, end) line spans of dependabot.yml's update entries: an entry
    is its `  - ` line under `updates:` and the more-indented lines after it."""
    lines = text.splitlines(keepends=True)
    if lines.count("updates:\n") != 1:
        raise ValueError("dependabot.yml needs exactly one top-level updates: list")
    first = lines.index("updates:\n") + 1
    spans, start = [], None
    for index, line in enumerate(lines[first:], first):
        if line.startswith("    ") and start is not None:
            continue
        if line.strip() and not line.startswith(" "):
            raise ValueError(f"dependabot.yml line {index + 1}: updates: must be the last top-level key")
        if start is not None:
            spans.append((start, index))
            start = None
        if line.startswith("  - "):
            start = index
        elif line.startswith("    "):
            raise ValueError(f"dependabot.yml line {index + 1} is outside an update entry")
    if start is not None:
        spans.append((start, len(lines)))
    return lines, spans


def target(lines, span):
    match = TARGET_BRANCH.search("".join(lines[span[0]:span[1]]))
    return match and match[1]


def add_line(text, previous, line):
    """dependabot.yml with a copy of each `previous` entry for `line`, right after it."""
    lines, spans = entries(text)
    if any(target(lines, span) == line for span in spans):
        raise ValueError(f"dependabot.yml already has {line} entries")
    copies = 0
    for start, end in reversed(spans):
        if target(lines, (start, end)) == previous:
            copy = TARGET_BRANCH.sub(f"    target-branch: {line}", "".join(lines[start:end]))
            lines[end:end] = ["\n", copy]
            copies += 1
    if not copies:
        raise ValueError(f"dependabot.yml has no {previous} entries to copy")
    return "".join(lines)


def move(text, line):
    """dependabot.yml with only `line` as its release target, and how many entries target it."""
    lines, spans = entries(text)
    targets = [target(lines, span) for span in spans]
    if line in targets:
        for (start, end), branch in reversed(list(zip(spans, targets))):
            if branch and branch != line:
                # The entry and the blank line that separates it from the next one.
                del lines[start:end + 1 if end < len(lines) and not lines[end].strip() else end]
        return "".join(lines), targets.count(line)
    if len({branch for branch in targets if branch}) > 1:
        raise ValueError(f"dependabot.yml has entries for several release lines, none of them {line}")
    return TARGET_BRANCH.subn(f"    target-branch: {line}", text)


def main(argv):
    if len(argv) != 2 or not LINE.fullmatch(argv[1]):
        raise SystemExit("usage: set-release-line.py release/X.Y")
    line = argv[1]
    root = Path(__file__).resolve().parents[2]
    targets = root / ".github/backport-targets.json"
    targets.write_text(f'{{\n  "branches": {json.dumps([line])}\n}}\n')
    dependabot = root / ".github/dependabot.yml"
    try:
        text, count = move(dependabot.read_text(), line)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    if not count:
        raise SystemExit("dependabot.yml has no release-line entries to move")
    dependabot.write_text(text)
    print(f"{line} is the supported release line ({count} Dependabot entries)")


if __name__ == "__main__":
    main(sys.argv)
