#!/usr/bin/env python3
"""Validate the source docs manifest without Node, network, or generated files."""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys


def validate_navigation(docs_dir: Path) -> list[str]:
    try:
        navigation = json.loads((docs_dir / "navigation.json").read_text())
    except (OSError, ValueError) as error:
        return [f"Cannot read docs/navigation.json: {error}"]
    if not isinstance(navigation, dict):
        return ["Navigation must be an object of category names and slug arrays"]
    pages_dir = docs_dir / "pages"
    if not pages_dir.is_dir():
        return ["Docs pages directory is missing"]
    pages = {page.stem for page in pages_dir.glob("*.md")}
    if not pages:
        return ["Docs pages directory contains no Markdown pages"]
    slugs: list[str] = []
    for category, entries in navigation.items():
        if (not category.strip() or not isinstance(entries, list) or not entries
                or any(not isinstance(slug, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug) for slug in entries)):
            return [f"Invalid navigation category: {category}"]
        slugs.extend(entries)
    errors = [f"Duplicate navigation slug: {slug}" for slug, count in Counter(slugs).items() if count > 1]
    errors.extend(f"Unknown navigation slug: {slug}" for slug in sorted(set(slugs) - pages))
    errors.extend(f"Page missing from navigation: {slug}" for slug in sorted(pages - set(slugs)))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docs-dir", type=Path, default=Path(__file__).resolve().parents[2] / "docs")
    args = parser.parse_args()
    errors = validate_navigation(args.docs_dir)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("Docs navigation check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
