#!/usr/bin/env python3
"""Check that internal links and asset embeds in docs/pages resolve to real files.

Scope (deterministic, no network):
  1. Internal page links (`/docs/<slug>` or `./<slug>`) -> `docs/pages/<slug>.md` exists.
  2. Asset embeds (`/docs/<path>.<ext>`) -> `docs/assets/<path>` exists.

Out of scope and skipped: external URLs (http/https/mailto), site routes outside
`/docs/` (e.g. `/book-demo`), `#anchor` fragments, and reference-style links. Links
inside fenced code blocks, inline code, and HTML comments are ignored.
"""

from __future__ import annotations

from pathlib import Path
import re
import sys

PAGES_DIR = Path("docs/pages")
ASSETS_DIR = Path("docs/assets")
ASSET_EXTENSIONS = {".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".mp4", ".pdf"}

FENCED_CODE = re.compile(r"```.*?```", re.DOTALL)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
INLINE_CODE = re.compile(r"`[^`]*`")
# Inline markdown link or image: [text](url) / ![alt](url). Capture the url up to
# the first whitespace (which would begin an optional "title") or the closing paren.
LINK = re.compile(r"!?\[[^\]]*\]\(\s*([^)\s]+)")


def strip_noise(text: str) -> str:
    text = FENCED_CODE.sub("", text)
    text = HTML_COMMENT.sub("", text)
    return INLINE_CODE.sub("", text)


def check_target(raw_url: str, source: Path) -> str | None:
    url = raw_url.strip().strip("<>")

    # Links to our own docs must be relative (/docs/...): an absolute archestra.ai
    # URL bypasses this checker and won't resolve in local dev preview.
    if re.match(r"^https?://(?:www\.)?archestra\.ai/docs/", url):
        return f"{source.name}: use a relative /docs/... link, not an absolute URL -> {url}"

    # External / protocol-relative / mailto / pure anchor: out of scope.
    if re.match(r"^[a-z][a-z0-9+.-]*://", url) or url.startswith(("mailto:", "//", "#", "tel:")):
        return None

    path = url.split("#", 1)[0]
    if not path:
        return None

    extension = Path(path).suffix.lower()

    # Asset embed.
    if extension in ASSET_EXTENSIONS:
        if not path.startswith("/docs/"):
            return None  # assets are referenced as /docs/<path>; anything else is unverifiable
        target = ASSETS_DIR / path[len("/docs/") :]
        if not target.is_file():
            return f"{source.name}: asset not found -> {url} (expected {target.as_posix()})"
        return None

    # Internal page link.
    if path.startswith("/docs/"):
        slug = path[len("/docs/") :].strip("/")
    elif path.startswith("./"):
        slug = path[2:].strip("/")
    elif path.startswith("/"):
        return None  # site route outside docs (e.g. /book-demo); not a docs page
    else:
        slug = path.strip("/")

    if not slug:
        return None  # `/docs` index

    target = PAGES_DIR / f"{slug}.md"
    if not target.is_file():
        return f"{source.name}: doc page not found -> {url} (expected docs/pages/{slug}.md)"
    return None


DOCS_TS = Path("platform/shared/docs.ts")
# Slug string values on the right-hand side of the DocsPage map entries.
DOCS_TS_SLUG = re.compile(r':\s*"((?:platform|mcp|security|contributing)[a-z0-9-]*)"')


def check_docs_ts() -> list[str]:
    """Every DocsPage slug in shared/docs.ts must resolve to a page file, so the
    app's "Learn more" links never point at a missing page."""
    if not DOCS_TS.is_file():
        return []
    text = DOCS_TS.read_text(encoding="utf-8")
    return [
        f"{DOCS_TS.as_posix()}: DocsPage slug has no page -> {slug} (expected docs/pages/{slug}.md)"
        for slug in DOCS_TS_SLUG.findall(text)
        if not (PAGES_DIR / f"{slug}.md").is_file()
    ]


def main() -> int:
    if not PAGES_DIR.is_dir():
        print(f"error: {PAGES_DIR} not found (run from the repo root)", file=sys.stderr)
        return 2

    violations: list[str] = []
    for page in sorted(PAGES_DIR.glob("*.md")):
        text = strip_noise(page.read_text(encoding="utf-8"))
        for match in LINK.finditer(text):
            violation = check_target(match.group(1), page)
            if violation:
                violations.append(violation)

    violations.extend(check_docs_ts())

    if not violations:
        print("Docs link check passed.")
        return 0

    print("Docs link check failures:", file=sys.stderr)
    for violation in violations:
        print(f"- {violation}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
