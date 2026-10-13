#!/usr/bin/env python3
"""Require every mention of a documented Prometheus metric in the docs to link to its row
on the Metrics page.

The rows are the "Metric" tables in docs/pages/admin/observability/metrics.md. Each
metric name in a row's first cell carries a `<span id="metric_name"></span>` anchor, and
a row without one is flagged too. A mention is inline code naming a documented metric
(`rag_queries_total`), and it must be written
[`rag_queries_total`](/docs/admin/observability/metrics#rag_queries_total). A link whose
text is the metric but whose target is elsewhere (for example a section heading) is also
flagged. Mentions inside fenced code blocks, headings, HTML comments, and other link
text are exempt (links do not render there), as is the Metrics page itself.

Run with --fix to add the missing anchors and rewrite mentions in place.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

PAGES_DIR = Path("docs/pages")
REFERENCE = PAGES_DIR / "admin/observability/metrics.md"
REFERENCE_URL = "/docs/admin/observability/metrics"

HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
TABLE_HEADER = re.compile(r"^\|\s*Metric\s*\|")
NAME = re.compile(r"`([a-z][a-z0-9_]*)`")
SPAN = re.compile(r'<span id="([a-z][a-z0-9_]*)"></span>')
# Inline code naming a metric that is not already the text of a link.
MENTION = re.compile(r"(?<!\[)`([a-z][a-z0-9_]*)`(?!\]\()")
# A link whose text is exactly such inline code.
LINKED = re.compile(r"\[`([a-z][a-z0-9_]*)`\]\(([^)\s]+)\)")
ANY_LINK = re.compile(r"\[(?:[^\[\]]|\[[^\]]*\])*\]\([^)]*\)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fix", action="store_true", help="add anchors and link mentions in place")
    args = parser.parse_args()

    if not REFERENCE.is_file():
        print(f"error: {REFERENCE} not found (run from the repo root)", file=sys.stderr)
        return 2

    violations: list[str] = []
    reference_text = REFERENCE.read_text(encoding="utf-8")
    anchored, metrics, missing = anchor_rows(reference_text)
    if missing:
        if args.fix:
            REFERENCE.write_text(anchored, encoding="utf-8")
            print(f"Anchored {len(missing)} metric(s) in {REFERENCE.as_posix()}")
        else:
            violations.extend(
                f'{REFERENCE.as_posix()}:{line}: add <span id="{name}"></span> before `{name}`' for line, name in missing
            )

    for page in sorted(PAGES_DIR.rglob("*.md")):
        if page == REFERENCE:
            continue
        text = page.read_text(encoding="utf-8")
        fixed, found = link_mentions(text, metrics)
        if not found:
            continue
        if args.fix:
            page.write_text(fixed, encoding="utf-8")
            print(f"Linked {len(found)} metric mention(s) in {page.as_posix()}")
        else:
            violations.extend(
                f"{page.as_posix()}:{line}: link `{name}` to {REFERENCE_URL}#{name}" for line, name in found
            )

    if not violations:
        if not args.fix:
            print("Docs metric link check passed.")
        return 0
    print(
        "Docs metric link check failures (fix with: python3 .github/scripts/check-docs-metric-links.py --fix):",
        file=sys.stderr,
    )
    for violation in violations:
        print(f"- {violation}", file=sys.stderr)
    return 1


def anchor_rows(text: str) -> tuple[str, frozenset[str], list[tuple[int, str]]]:
    """Return the page with every metric anchored, the metric names, and the (line, name) anchors added."""
    metrics: set[str] = set()
    missing: list[tuple[int, str]] = []
    out: list[str] = []
    in_metric_table = False
    for number, line in enumerate(text.split("\n"), start=1):
        if TABLE_HEADER.match(line):
            in_metric_table = True
            out.append(line)
            continue
        if not line.startswith("|"):
            in_metric_table = False
        if not in_metric_table or re.match(r"^\|\s*-", line):
            out.append(line)
            continue
        cells = line.split("|")
        first = cells[1]
        spans = set(SPAN.findall(first))
        names = NAME.findall(first)
        metrics.update(names)

        def anchor(match: re.Match[str]) -> str:
            name = match.group(1)
            if name in spans:
                return match.group(0)
            missing.append((number, name))
            return f'<span id="{name}"></span>{match.group(0)}'

        cells[1] = NAME.sub(anchor, first)
        out.append("|".join(cells))
    return "\n".join(out), frozenset(metrics), missing


def link_mentions(text: str, metrics: frozenset[str]) -> tuple[str, list[tuple[int, str]]]:
    """Return the text with every mention linked to its row, and the (line, metric) fixes made."""
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
        if index < frontmatter_end:
            out.append(line)
            continue
        if re.match(r"^\s*```", line):
            in_fence = not in_fence
        if in_fence or line.lstrip().startswith(("#", "```")) or any(a <= start < b for a, b in comment_spans):
            out.append(line)
            continue

        def retarget(match: re.Match[str]) -> str:
            name, url = match.group(1), match.group(2)
            expected = f"{REFERENCE_URL}#{name}"
            if name not in metrics or url == expected:
                return match.group(0)
            found.append((number, name))
            return f"[`{name}`]({expected})"

        line = LINKED.sub(retarget, line)
        link_spans = [match.span() for match in ANY_LINK.finditer(line)]

        def link(match: re.Match[str]) -> str:
            name = match.group(1)
            if name not in metrics or any(a <= match.start() < b for a, b in link_spans):
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
