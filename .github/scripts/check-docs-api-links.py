#!/usr/bin/env python3
"""Require every platform API route mentioned in the docs to deep-link to its operation in
the API reference, and every API reference deep link to name a real operation.

A mention is inline code with an HTTP method and an /api path, such as `GET /api/agents`
or `PUT /api/knowledge-files/:fileId/content`. It must be written as a link to
/docs/reference/api#/<tag>/<operationId>, the deep link the reference's Swagger UI opens.
Mentions inside fenced code blocks, headings, and HTML comments are exempt.

Operations come from docs/openapi.json. A route without an operationId cannot be
deep-linked; give it one in the backend route schema.

Run with --fix to link unlinked mentions in place.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from urllib.parse import quote, unquote

PAGES_DIR = Path("docs/pages")
OPENAPI = Path("docs/openapi.json")
REFERENCE_URL = "/docs/reference/api"

METHODS = ("get", "post", "put", "patch", "delete")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
# Inline-code route that is not already the text of a link.
MENTION = re.compile(r"(?<!\[)`(GET|POST|PUT|PATCH|DELETE) (/api/[^`\s?]*)[^`]*`(?!\]\()")
DEEP_LINK = re.compile(re.escape(REFERENCE_URL) + r"#(/[^)\s\"']+)")
PATH_PARAM = re.compile(r"\{[^}]+\}|<[^>]+>|:[A-Za-z_][A-Za-z0-9_]*")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fix", action="store_true", help="link unlinked mentions in place")
    args = parser.parse_args()

    if not OPENAPI.is_file():
        print(f"error: {OPENAPI} not found (run from the repo root)", file=sys.stderr)
        return 2
    operations = load_operations()
    deep_links = {link for link, _ in operations.values() if link}

    violations: list[str] = []
    for page in sorted(PAGES_DIR.rglob("*.md")):
        text = page.read_text(encoding="utf-8")
        for number, line in enumerate(text.split("\n"), start=1):
            for match in DEEP_LINK.finditer(line):
                if match.group(1) not in deep_links:
                    violations.append(f"{page.as_posix()}:{number}: no API operation for {REFERENCE_URL}#{match.group(1)}")
        fixed, found, unknown = link_mentions(text, operations)
        for number, route in unknown:
            violations.append(f"{page.as_posix()}:{number}: `{route}` is not a documented API operation with an operationId")
        if not found:
            continue
        if args.fix:
            page.write_text(fixed, encoding="utf-8")
            print(f"Linked {len(found)} API route mention(s) in {page.as_posix()}")
        else:
            violations.extend(f"{page.as_posix()}:{number}: link `{route}` to {REFERENCE_URL}#{link}" for number, route, link in found)

    if not violations:
        if not args.fix:
            print("Docs API link check passed.")
        return 0
    print("Docs API link check failures (link mentions with: python3 .github/scripts/check-docs-api-links.py --fix):", file=sys.stderr)
    for violation in violations:
        print(f"- {violation}", file=sys.stderr)
    return 1


def load_operations() -> dict[tuple[str, str], tuple[str | None, str]]:
    """Map (METHOD, normalized path) to (deep link fragment or None, spec path)."""
    spec = json.loads(OPENAPI.read_text(encoding="utf-8"))
    operations: dict[tuple[str, str], tuple[str | None, str]] = {}
    for path, item in spec.get("paths", {}).items():
        for method in METHODS:
            operation = item.get(method)
            if not isinstance(operation, dict):
                continue
            tags = operation.get("tags") or ["default"]
            operation_id = operation.get("operationId")
            link = deep_link(tags[0], operation_id) if operation_id else None
            operations[(method.upper(), normalize(path))] = (link, path)
    return operations


def deep_link(tag: str, operation_id: str) -> str:
    """The fragment Swagger UI's deepLinking writes: spaces become %20."""
    return f"/{quote(tag, safe='')}/{quote(operation_id, safe='')}"


def normalize(path: str) -> str:
    """Treat {id}, :id, and <id> the same, so the docs can use any spelling."""
    return PATH_PARAM.sub("{}", unquote(path).rstrip("/") or "/")


def find_operation(
    operations: dict[tuple[str, str], tuple[str | None, str]], method: str, path: str
) -> tuple[str | None, str] | None:
    """The operation for a mentioned route. A spec parameter also matches a literal value,
    as in /api/resource-permissions/mcpRegistry/<id>; the route with the most literal
    segments wins."""
    exact = operations.get((method, normalize(path)))
    if exact:
        return exact
    wanted = normalize(path).split("/")
    best: tuple[int, tuple[str | None, str]] | None = None
    for (candidate_method, candidate_path), operation in operations.items():
        segments = candidate_path.split("/")
        if candidate_method != method or len(segments) != len(wanted):
            continue
        if all(have == want or have == "{}" for have, want in zip(segments, wanted)):
            literal = sum(have != "{}" for have in segments)
            if best is None or literal > best[0]:
                best = (literal, operation)
    return best[1] if best else None


def link_mentions(
    text: str, operations: dict[tuple[str, str], tuple[str | None, str]]
) -> tuple[str, list[tuple[int, str, str]], list[tuple[int, str]]]:
    """Return the text with linkable mentions linked, the (line, route, link) mentions
    found, and the (line, route) mentions that match no deep-linkable operation."""
    found: list[tuple[int, str, str]] = []
    unknown: list[tuple[int, str]] = []
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
            route = f"{match.group(1)} {match.group(2)}"
            operation = find_operation(operations, match.group(1), match.group(2))
            if not operation or not operation[0]:
                unknown.append((number, route))
                return match.group(0)
            found.append((number, route, operation[0]))
            return f"[{match.group(0)}]({REFERENCE_URL}#{operation[0]})"

        out.append(MENTION.sub(link, line))
    return "\n".join(out), found, unknown


if __name__ == "__main__":
    raise SystemExit(main())
