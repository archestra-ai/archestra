#!/usr/bin/env python3
"""Reject newly locked registry crates published less than seven days ago.

Requires Python 3.11+. Existing base-lockfile versions are grandfathered.
This is a CI/manual check, not a Cargo resolver or a check of git dependencies.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tomllib
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-ref", required=True, help="Trusted base commit to compare against"
    )
    parser.add_argument(
        "--lockfile",
        required=True,
        action="append",
        help="Repository-relative Cargo.lock path",
    )
    args = parser.parse_args()
    try:
        root = Path(
            subprocess.check_output(
                ["git", "rev-parse", "--show-toplevel"], text=True
            ).strip()
        )
        now = datetime.now(UTC)
        failures = []
        for lockfile in args.lockfile:
            base = subprocess.check_output(
                ["git", "show", f"{args.base_ref}:{lockfile}"], cwd=root, text=True
            )
            current = (root / lockfile).read_text()
            failures.extend(
                f"{lockfile}: {failure}"
                for failure in check_versions(base, current, now)
            )
        if failures:
            print("\n".join(failures), file=sys.stderr)
            return 1
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.CalledProcessError,
    ) as error:
        print(f"Cannot verify Cargo release ages: {error}", file=sys.stderr)
        return 1
    print(
        "Cargo release age check passed (new registry versions must be at least 7 days old)."
    )
    return 0


def check_versions(base: str, current: str, now: datetime) -> list[str]:
    failures = []
    for name, version, source in sorted(
        registry_versions(current) - registry_versions(base)
    ):
        if source != CRATES_IO:
            failures.append(
                f"{name}@{version}: cannot verify unsupported registry {source}"
            )
            continue
        published = publication_time(name, version)
        eligible = published + timedelta(days=7)
        if now < eligible:
            failures.append(
                f"{name}@{version}: published {published.isoformat()}; eligible {eligible.isoformat()}"
            )
    return failures


def registry_versions(lockfile: str) -> set[tuple[str, str, str]]:
    # Cargo records every resolved version, including transitive dependencies.
    return {
        (package["name"], package["version"], package["source"])
        for package in tomllib.loads(lockfile)["package"]
        if package.get("source", "").startswith(("registry+", "sparse+"))
    }


def publication_time(name: str, version: str) -> datetime:
    request = Request(
        f"https://crates.io/api/v1/crates/{quote(name, safe='')}/{quote(version, safe='')}",
        headers={
            "User-Agent": "cargo-release-age-check (https://github.com/archestra-ai)",
            "Accept": "application/json",
        },
    )
    with urlopen(request, timeout=30) as response:
        metadata = json.load(response)["version"]
    if metadata["num"] != version or metadata["crate"] != name:
        raise ValueError(f"Unexpected registry metadata for {name}@{version}")
    published = datetime.fromisoformat(metadata["created_at"])
    if published.utcoffset() is None:
        raise ValueError(f"Missing publication timezone for {name}@{version}")
    return published


CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index"


if __name__ == "__main__":
    raise SystemExit(main())
