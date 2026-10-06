#!/usr/bin/env python3
"""Require every mention of an RBAC permission in the docs to link to its entry in the
generated permissions reference (docs/pages/reference/permissions.md).

A mention is an inline-code `resource:action` name:
`agent:read` must be written [`agent:read`](/docs/reference/permissions#agent:read).
Mentions inside fenced code blocks, headings, and HTML comments are exempt (links do
not render there), as is the reference page itself.

Run with --fix to rewrite unlinked mentions in place.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

PAGES_DIR = Path("docs/pages")
REFERENCE = PAGES_DIR / "reference/permissions.md"
REFERENCE_URL = "/docs/reference/permissions"

# Each permission row in the generated table carries a `<span id="resource:action">` anchor.
PERMISSION_ANCHOR = re.compile(r'<span id="([A-Za-z]+:[a-z-]+)"></span>')
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
# Inline code that is not already the text of a link.
MENTION = re.compile(r"(?<!\[)`([A-Za-z]+:[a-z-]+)`(?!\]\()")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fix", action="store_true", help="link unlinked mentions in place")
    args = parser.parse_args()

    if not REFERENCE.is_file():
        print(f"error: {REFERENCE} not found (run from the repo root)", file=sys.stderr)
        return 2
    tools = load_permissions()

    violations: list[str] = []
    for page in sorted(PAGES_DIR.rglob("*.md")):
        if page == REFERENCE:
            continue
        text = page.read_text(encoding="utf-8")
        fixed, found = link_mentions(text, tools)
        if not found:
            continue
        if args.fix:
            page.write_text(fixed, encoding="utf-8")
            print(f"Linked {len(found)} permission mention(s) in {page.as_posix()}")
        else:
            violations.extend(f"{page.as_posix()}:{line}: link `{tool}` to {REFERENCE_URL}#{tool}" for line, tool in found)

    if not violations:
        if not args.fix:
            print("Docs permission link check passed.")
        return 0
    print("Docs permission link check failures (fix with: python3 .github/scripts/check-docs-permission-links.py --fix):", file=sys.stderr)
    for violation in violations:
        print(f"- {violation}", file=sys.stderr)
    return 1


def load_permissions() -> frozenset[str]:
    return frozenset(PERMISSION_ANCHOR.findall(REFERENCE.read_text(encoding="utf-8")))


def link_mentions(text: str, tools: frozenset[str]) -> tuple[str, list[tuple[int, str]]]:
    """Return the text with every unlinked permission mention linked, and the (line, permission) mentions found."""
    found: list[tuple[int, str]] = []
    comment_spans = [match.span() for match in HTML_COMMENT.finditer(text)]
    out: list[str] = []
    in_fence = False
    offset = 0
    for number, line in enumerate(text.split("\n"), start=1):
        start = offset
        offset += len(line) + 1
        if re.match(r"^\s*```", line):
            in_fence = not in_fence
        if in_fence or line.lstrip().startswith(("#", "```")) or any(a <= start < b for a, b in comment_spans):
            out.append(line)
            continue

        def link(match: re.Match[str]) -> str:
            tool = match.group(1)
            if tool not in tools:
                return match.group(0)
            found.append((number, tool))
            return f"[{match.group(0)}]({REFERENCE_URL}#{tool})"

        out.append(MENTION.sub(link, line))
    return "\n".join(out), found


if __name__ == "__main__":
    raise SystemExit(main())
