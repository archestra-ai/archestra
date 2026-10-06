#!/usr/bin/env python3
"""Require every mention of a documented environment variable in the docs to link to its
exact entry in the reference on the Deployment page.

The reference entries are the `- **`ARCHESTRA_X`** - …` bullets in
docs/pages/reference/configuration.md; the website anchors each one by the
variable's name. A mention is inline code naming a documented variable, alone or with a
value (`ARCHESTRA_X` or `ARCHESTRA_X=true`), and it must be written
[`ARCHESTRA_X`](/docs/reference/configuration#ARCHESTRA_X). A link whose text is the
variable but whose target is elsewhere (for example the page top) is also flagged.
Mentions inside fenced code blocks, headings, HTML comments, and other link text are
exempt (links do not render there), as are the entries themselves. In frontmatter, only
the rendered `beta:` notice is checked.

Run with --fix to rewrite mentions in place.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

PAGES_DIR = Path("docs/pages")
REFERENCE = PAGES_DIR / "reference/configuration.md"
REFERENCE_URL = "/docs/reference/configuration"

ENTRY = re.compile(r"^\s*[-*] \*\*`(ARCHESTRA_[A-Z0-9_]+)`\*\*", re.MULTILINE)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
# Inline code naming a variable, optionally with `=value`, that is not entry markup.
MENTION = re.compile(r"(?<![\[*])`(ARCHESTRA_[A-Z0-9_]+)(=[^`]*)?`(?![\]*])")
# A link whose text is exactly such inline code.
LINKED = re.compile(r"\[`(ARCHESTRA_[A-Z0-9_]+)(=[^`]*)?`\]\(([^)\s]+)\)")
ANY_LINK = re.compile(r"\[(?:[^\[\]]|\[[^\]]*\])*\]\([^)]*\)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fix", action="store_true", help="link mentions in place")
    args = parser.parse_args()

    if not REFERENCE.is_file():
        print(f"error: {REFERENCE} not found (run from the repo root)", file=sys.stderr)
        return 2
    variables = frozenset(ENTRY.findall(REFERENCE.read_text(encoding="utf-8")))

    violations: list[str] = []
    for page in sorted(PAGES_DIR.rglob("*.md")):
        text = page.read_text(encoding="utf-8")
        fixed, found = link_mentions(text, variables)
        if not found:
            continue
        if args.fix:
            page.write_text(fixed, encoding="utf-8")
            print(f"Linked {len(found)} environment variable mention(s) in {page.as_posix()}")
        else:
            violations.extend(
                f"{page.as_posix()}:{line}: link `{name}` to {REFERENCE_URL}#{name}" for line, name in found
            )

    if not violations:
        if not args.fix:
            print("Docs environment variable link check passed.")
        return 0
    print(
        "Docs environment variable link check failures "
        "(fix with: python3 .github/scripts/check-docs-env-var-links.py --fix):",
        file=sys.stderr,
    )
    for violation in violations:
        print(f"- {violation}", file=sys.stderr)
    return 1


def link_mentions(text: str, variables: frozenset[str]) -> tuple[str, list[tuple[int, str]]]:
    """Return the text with every mention linked to its entry, and the (line, variable) fixes made."""
    found: list[tuple[int, str]] = []
    comment_spans = [match.span() for match in HTML_COMMENT.finditer(text)]
    lines = text.split("\n")
    frontmatter_end = frontmatter_length(lines)
    out: list[str] = []
    in_fence = False
    offset = 0
    for index, line in enumerate(lines):
        number = index + 1
        start = offset
        offset += len(line) + 1
        if index < frontmatter_end and not line.startswith("beta:"):
            out.append(line)
            continue
        if re.match(r"^\s*```", line):
            in_fence = not in_fence
        if in_fence or line.lstrip().startswith(("#", "```")) or any(a <= start < b for a, b in comment_spans):
            out.append(line)
            continue

        def retarget(match: re.Match[str]) -> str:
            name, value, url = match.group(1), match.group(2) or "", match.group(3)
            expected = f"{REFERENCE_URL}#{name}"
            if name not in variables or url == expected:
                return match.group(0)
            found.append((number, name))
            return f"[`{name}{value}`]({expected})"

        line = LINKED.sub(retarget, line)
        link_spans = [match.span() for match in ANY_LINK.finditer(line)]

        def link(match: re.Match[str]) -> str:
            name = match.group(1)
            if name not in variables or any(a <= match.start() < b for a, b in link_spans):
                return match.group(0)
            found.append((number, name))
            return f"[{match.group(0)}]({REFERENCE_URL}#{name})"

        out.append(MENTION.sub(link, line))
    return "\n".join(out), found


def frontmatter_length(lines: list[str]) -> int:
    """Number of leading lines that belong to the YAML frontmatter (0 when there is none)."""
    if not lines or lines[0] != "---":
        return 0
    for index in range(1, len(lines)):
        if lines[index] == "---":
            return index + 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
