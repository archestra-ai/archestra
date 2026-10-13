#!/usr/bin/env python3
"""Validate the docs folder tree, frontmatter, and redirects without Node or network.

The folder tree under docs/pages is the docs navigation:
  - every page lives in a top-level section folder, except the docs home (index.md at the root);
  - every folder has an index.md, which is that folder's own page;
  - folders nest at most MAX_DEPTH levels, and paths use lowercase words and hyphens;
  - every page has `title`, `description`, and a numeric `order` unique among its siblings.

Redirect sources must not shadow a page, and destinations must resolve to a page.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

MAX_DEPTH = 4
SEGMENT = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)


def validate_tree(docs_dir: Path) -> list[str]:
    pages_dir = docs_dir / "pages"
    if not pages_dir.is_dir():
        return ["Docs pages directory is missing"]
    if not any(pages_dir.rglob("*.md")):
        return ["Docs pages directory contains no Markdown pages"]

    errors = [
        f"Page must live in a section folder: {page.name}"
        for page in sorted(pages_dir.glob("*.md"))
        if page.name != "index.md"
    ]
    for folder in sorted(path for path in pages_dir.rglob("*") if path.is_dir()):
        relative = folder.relative_to(pages_dir)
        if len(relative.parts) > MAX_DEPTH:
            errors.append(f"Docs nest at most {MAX_DEPTH} levels deep: {relative.as_posix()}")
        if not (folder / "index.md").is_file():
            errors.append(f"Docs folder has no index.md: {relative.as_posix()}")

    orders: dict[tuple[Path, int], str] = {}
    for page in sorted(pages_dir.rglob("*.md")):
        relative = page.relative_to(pages_dir)
        if not all(SEGMENT.fullmatch(part) for part in (*relative.parent.parts, relative.stem)):
            errors.append(f"Docs paths use lowercase words and hyphens: {relative.as_posix()}")
        fields = read_frontmatter(page)
        for key in ("title", "description"):
            if not fields.get(key):
                errors.append(f"Page needs `{key}` frontmatter: {relative.as_posix()}")
        if not re.fullmatch(r"\d+", fields.get("order", "")):
            errors.append(f"Page needs a numeric `order` frontmatter: {relative.as_posix()}")
            continue
        # A folder's index.md is ordered among the folder's siblings.
        parent = relative.parent.parent if relative.name == "index.md" else relative.parent
        key = (parent, int(fields["order"]))
        if key in orders:
            errors.append(f"Pages share order {key[1]}: {orders[key]}, {relative.as_posix()}")
        orders[key] = relative.as_posix()

    errors.extend(validate_redirects(docs_dir))
    return errors


def page_exists(pages_dir: Path, url: str) -> bool:
    slug = url.split("#", 1)[0].removeprefix("/docs/").strip("/")
    return bool(slug) and ((pages_dir / f"{slug}.md").is_file() or (pages_dir / slug / "index.md").is_file())


def validate_redirects(docs_dir: Path) -> list[str]:
    path = docs_dir / "redirects.json"
    if not path.is_file():
        return []
    try:
        redirects = json.loads(path.read_text())["redirects"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        return [f"Cannot read docs/redirects.json: {error}"]
    pages_dir = docs_dir / "pages"
    errors = []
    for entry in redirects:
        source, destination = entry.get("source", ""), entry.get("destination", "")
        if source.startswith("/docs/") and page_exists(pages_dir, source):
            errors.append(f"Redirect source shadows a page: {source}")
        if destination.startswith("/docs/") and not page_exists(pages_dir, destination):
            errors.append(f"Redirect destination has no page: {source} -> {destination}")
    return errors


def read_frontmatter(page: Path) -> dict[str, str]:
    match = FRONTMATTER.match(page.read_text(encoding="utf-8"))
    if not match:
        return {}
    fields = {}
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep and not line.startswith((" ", "\t")):
            fields[key.strip()] = value.strip().strip("\"'")
    return fields


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docs-dir", type=Path, default=Path(__file__).resolve().parents[2] / "docs")
    args = parser.parse_args()
    errors = validate_tree(args.docs_dir)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("Docs navigation check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
