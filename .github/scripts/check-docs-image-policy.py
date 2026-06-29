#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path
import sys

KB = 1024
MAX_WEBP_BYTES = 500 * KB
ALLOWED_VECTOR_EXTENSIONS = {".svg"}
ASSETS_DIR = Path("docs/assets")


def format_bytes(num_bytes: int) -> str:
    return f"{num_bytes / KB:.1f} KB"


def main() -> int:
    violations: list[str] = []

    for asset_path in sorted(path for path in ASSETS_DIR.rglob("*") if path.is_file()):
        relative_path = asset_path.relative_to(ASSETS_DIR).as_posix()
        extension = asset_path.suffix.lower()
        size_bytes = asset_path.stat().st_size

        if extension in ALLOWED_VECTOR_EXTENSIONS:
            continue

        if extension == ".webp":
            if size_bytes > MAX_WEBP_BYTES:
                violations.append(
                    f"{relative_path}: {format_bytes(size_bytes)} exceeds the {format_bytes(MAX_WEBP_BYTES)} WebP budget."
                )
            continue

        violations.append(
            f"{relative_path}: unsupported raster format '{extension}'. Convert docs assets to .webp."
        )

    if not violations:
        print("Docs image policy passed.")
        return 0

    print("Docs image policy failures:", file=sys.stderr)
    for violation in violations:
        print(f"- {violation}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
