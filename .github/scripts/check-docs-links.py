#!/usr/bin/env python3
"""Check that internal links and asset embeds in docs/pages resolve to real files.

Scope (deterministic, no network):
  1. Internal page links (`/docs/<path>`) -> `docs/pages/<path>.md` or `docs/pages/<path>/index.md`
     exists. Pages are nested, so relative page links are rejected: they resolve differently
     depending on the linking page's folder.
  2. Asset embeds (`/docs/<path>.<ext>`) -> `docs/assets/<path>` exists.
  3. `#anchor` fragments -> a heading (slugged like the website's rehype-slug, i.e.
     github-slugger), an HTML `id`/`name`, or an environment variable entry
     (`- **`ARCHESTRA_X`** - …`, anchored as `#ARCHESTRA_X`) on the target page. Covers cross-page
     links, same-page `#links`, and docs/redirects.json destinations.

Out of scope and skipped: external URLs (http/https/mailto), site routes outside
`/docs/` (e.g. `/book-demo`), and reference-style links. Links inside fenced code
blocks and HTML comments are ignored.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
import re
import sys
import unicodedata

PAGES_DIR = Path("docs/pages")
ASSETS_DIR = Path("docs/assets")
ASSET_EXTENSIONS = {".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".mp4", ".pdf"}

FENCED_CODE = re.compile(r"```.*?```", re.DOTALL)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
INLINE_CODE = re.compile(r"`[^`]*`")
# Inline markdown link or image: [text](url) / ![alt](url). Capture the url up to
# the first whitespace (which would begin an optional "title") or the closing paren.
LINK = re.compile(r"!?\[[^\]]*\]\(\s*([^)\s]+)")
HEADING = re.compile(r"^\s*#{1,6}\s+(.+?)\s*#*\s*$")
HTML_ID = re.compile(r"""<[a-zA-Z][^>]*\s(?:id|name)=["']([^"']+)["']""")
# An environment variable reference entry; the website anchors it by the variable's name.
ENV_VAR_ENTRY = re.compile(r"^\s*[-*] \*\*`(ARCHESTRA_[A-Z0-9_]+)`\*\*")
REDIRECTS = Path("docs/redirects.json")


def strip_noise(text: str) -> str:
    text = FENCED_CODE.sub("", text)
    text = HTML_COMMENT.sub("", text)
    return INLINE_CODE.sub("", text)


def check_target(raw_url: str, source: Path) -> str | None:
    url = raw_url.strip().strip("<>")

    # Links to our own docs must be relative (/docs/...): an absolute archestra.ai
    # URL bypasses this checker and won't resolve in local dev preview.
    if re.match(r"^https?://(?:www\.)?archestra\.ai/docs/", url):
        return f"{source.as_posix()}: use a relative /docs/... link, not an absolute URL -> {url}"

    # External / protocol-relative / mailto: out of scope.
    if re.match(r"^[a-z][a-z0-9+.-]*://", url) or url.startswith(("mailto:", "//", "tel:")):
        return None

    path, _, fragment = url.partition("#")
    if not path:
        return check_anchor(source, fragment, url, source)

    extension = Path(path).suffix.lower()

    # Asset embed.
    if extension in ASSET_EXTENSIONS:
        if not path.startswith("/docs/"):
            return None  # assets are referenced as /docs/<path>; anything else is unverifiable
        target = ASSETS_DIR / path[len("/docs/") :]
        if not target.is_file():
            return f"{source.as_posix()}: asset not found -> {url} (expected {target.as_posix()})"
        return None

    # Internal page link.
    if path.startswith("/docs/"):
        slug = path[len("/docs/") :].strip("/")
    elif path.startswith("/"):
        return None  # site route outside docs (e.g. /book-demo); not a docs page
    else:
        return f"{source.as_posix()}: use an absolute /docs/... page link, not a relative one -> {url}"

    if not slug:
        return None  # `/docs` index

    target = page_file(slug)
    if target is None:
        return f"{source.as_posix()}: doc page not found -> {url} (expected docs/pages/{slug}.md or {slug}/index.md)"
    return check_anchor(target, fragment, url, source)


def page_exists(slug: str) -> bool:
    return page_file(slug) is not None


def page_file(slug: str) -> Path | None:
    for candidate in (PAGES_DIR / f"{slug}.md", PAGES_DIR / slug / "index.md"):
        if candidate.is_file():
            return candidate
    return None


def check_anchor(target: Path, fragment: str, url: str, source: Path | str) -> str | None:
    if fragment.startswith("/") and target.as_posix().endswith("reference/api.md"):
        return None  # a Swagger UI operation deep link; check-docs-api-links.py validates it
    if not fragment or fragment in page_anchors(target):
        return None
    where = source.as_posix() if isinstance(source, Path) else source
    return f"{where}: anchor not found on {target.as_posix()} -> {url}"


@cache
def page_anchors(page: Path) -> frozenset[str]:
    """Anchor ids the website renders for a page: slugged headings, raw HTML ids, env var entries."""
    text = HTML_COMMENT.sub("", page.read_text(encoding="utf-8"))
    counts: dict[str, int] = {}
    anchors: set[str] = set()
    in_fence = False
    for line in text.split("\n"):
        if re.match(r"^\s*```", line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        anchors.update(HTML_ID.findall(line))
        anchors.update(ENV_VAR_ENTRY.findall(line))
        heading = HEADING.match(line)
        if heading:
            anchors.add(github_slug(heading_text(heading.group(1)), counts))
    return frozenset(anchors)


def heading_text(markdown: str) -> str:
    """The plain text a heading renders to (what rehype-slug slugs)."""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", markdown)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("`", "")
    text = re.sub(r"(\*\*|__)(.+?)\1", r"\2", text)
    text = re.sub(r"(?<!\w)[*_](.+?)[*_](?!\w)", r"\1", text)
    return text.strip()


def github_slug(text: str, counts: dict[str, int]) -> str:
    """Port of github-slugger: lowercase, drop punctuation/symbols except `-` and `_`,
    spaces to `-`, and suffix repeats on the same page with -1, -2, ..."""
    kept = "".join(
        ch
        for ch in text.lower()
        if ch in "-_ " or unicodedata.category(ch)[0] in "LNM"
    )
    base = kept.replace(" ", "-")
    slug = base
    while slug in counts:
        counts[base] += 1
        slug = f"{base}-{counts[base]}"
    counts[slug] = 0
    return slug


def check_redirects() -> list[str]:
    """Redirect destinations that carry a fragment must land on a real anchor."""
    if not REDIRECTS.is_file():
        return []
    violations = []
    for entry in json.loads(REDIRECTS.read_text(encoding="utf-8")).get("redirects", []):
        destination = entry.get("destination", "")
        path, _, fragment = destination.partition("#")
        if not fragment or not path.startswith("/docs/"):
            continue
        target = page_file(path[len("/docs/") :].strip("/"))
        if target is not None:
            violation = check_anchor(target, fragment, destination, REDIRECTS.as_posix())
            if violation:
                violations.append(violation)
    return violations


DOCS_TS = Path("platform/shared/docs.ts")
DOCS_PAGE_MAP = re.compile(r"export const DocsPage = \{(.*?)\}", re.DOTALL)
# Slug string values on the right-hand side of the DocsPage map entries.
DOCS_TS_SLUG = re.compile(r':\s*"([a-z0-9-]+(?:/[a-z0-9-]+)*)"')


def check_docs_ts() -> list[str]:
    """Every DocsPage slug in shared/docs.ts must resolve to a page file, so the
    app's "Learn more" links never point at a missing page."""
    if not DOCS_TS.is_file():
        return []
    match = DOCS_PAGE_MAP.search(DOCS_TS.read_text(encoding="utf-8"))
    if not match:
        return [f"{DOCS_TS.as_posix()}: DocsPage map not found"]
    return [
        f"{DOCS_TS.as_posix()}: DocsPage slug has no page -> {slug}"
        for slug in DOCS_TS_SLUG.findall(match.group(1))
        if not page_exists(slug)
    ]


def main() -> int:
    if not PAGES_DIR.is_dir():
        print(f"error: {PAGES_DIR} not found (run from the repo root)", file=sys.stderr)
        return 2

    violations: list[str] = []
    for page in sorted(PAGES_DIR.rglob("*.md")):
        text = strip_noise(page.read_text(encoding="utf-8"))
        for match in LINK.finditer(text):
            violation = check_target(match.group(1), page)
            if violation:
                violations.append(violation)

    violations.extend(check_redirects())
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
