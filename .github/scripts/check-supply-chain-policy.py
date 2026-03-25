#!/usr/bin/env python3

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


LATEST_ALLOW_MARKER = "supply-chain-policy: allow-latest"
DOWNLOAD_ALLOW_MARKER = "supply-chain-policy: allow-unverified-download"

LOCAL_URL_PREFIXES = (
    "http://localhost",
    "http://127.0.0.1",
    "https://localhost",
    "https://127.0.0.1",
)


def main() -> int:
    repo_root = Path(
        subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True
        ).strip()
    )
    candidate_files = list(iter_candidate_files(repo_root))
    failures: list[str] = []

    for file_path in candidate_files:
        relative_path = file_path.relative_to(repo_root)
        lines = file_path.read_text(encoding="utf-8").splitlines()

        for line_number, line in enumerate(lines, start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if is_non_executable_metadata_line(stripped):
                continue

            if ":latest" in line and not has_inline_or_previous_marker(
                lines, line_number - 1, LATEST_ALLOW_MARKER
            ):
                failures.append(
                    format_failure(
                        relative_path,
                        line_number,
                        "floating :latest reference without explicit allow marker",
                        line,
                    )
                )

            if not looks_like_remote_download(line):
                continue

            if has_inline_or_previous_marker(lines, line_number - 1, DOWNLOAD_ALLOW_MARKER):
                continue

            if is_post_only_webhook(line):
                continue

            if has_local_url(line):
                continue

            if not has_nearby_verification(lines, line_number - 1):
                failures.append(
                    format_failure(
                        relative_path,
                        line_number,
                        "remote download without checksum/signature verification or allow marker",
                        line,
                    )
                )

    if failures:
        print("Supply-chain policy violations found:", file=sys.stderr)
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1

    print("Supply-chain policy checks passed.")
    return 0


def iter_candidate_files(repo_root: Path):
    yield from sorted((repo_root / ".github").rglob("*.yml"))
    yield from sorted(repo_root.rglob("Dockerfile*"))
    docker_dir = repo_root / "platform" / "docker"
    if docker_dir.exists():
        yield from sorted(docker_dir.rglob("*.sh"))


def looks_like_remote_download(line: str) -> bool:
    remote_url = re.search(r"https?://[^\s\"')]+", line)
    if not remote_url:
        return False
    return any(
        token in line for token in ("curl ", "wget ", "helm plugin install ")
    )


def is_post_only_webhook(line: str) -> bool:
    return "curl" in line and "-X POST" in line


def has_local_url(line: str) -> bool:
    return any(prefix in line for prefix in LOCAL_URL_PREFIXES)


def has_nearby_verification(lines: list[str], index: int) -> bool:
    window = "\n".join(lines[index : min(len(lines), index + 12)])
    verification_markers = (
        "sha256sum -c",
        "sha512sum -c",
        "shasum -a 256 -c",
        "cosign verify",
        "gpg --verify",
        "minisign -Vm",
    )
    return any(marker in window for marker in verification_markers)


def has_inline_or_previous_marker(
    lines: list[str], index: int, marker: str
) -> bool:
    if marker in lines[index]:
        return True

    previous_index = index - 1
    remaining_lines = 8
    while previous_index >= 0 and remaining_lines > 0:
        previous_line = lines[previous_index].strip()
        if not previous_line:
            previous_index -= 1
            continue
        if marker in previous_line:
            return True
        previous_index -= 1
        remaining_lines -= 1

    return False


def is_non_executable_metadata_line(stripped: str) -> bool:
    return stripped.startswith(("description:", "default:"))


def format_failure(path: Path, line_number: int, reason: str, line: str) -> str:
    return f"- {path}:{line_number}: {reason}\n  {line.strip()}"


if __name__ == "__main__":
    raise SystemExit(main())
