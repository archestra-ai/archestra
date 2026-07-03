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
    failures = collect_failures(repo_root)

    if failures:
        print("Supply-chain policy violations found:", file=sys.stderr)
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1

    print("Supply-chain policy checks passed.")
    return 0


def collect_failures(repo_root: Path) -> list[str]:
    failures: list[str] = []

    for file_path in iter_candidate_files(repo_root):
        relative_path = file_path.relative_to(repo_root)
        physical_lines = file_path.read_text(encoding="utf-8").splitlines()
        logical_lines = fold_continuations(physical_lines)
        texts = [text for _, text in logical_lines]

        for index, (line_number, line) in enumerate(logical_lines):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if is_non_executable_metadata_line(stripped):
                continue

            if ":latest" in line and not has_inline_or_previous_marker(
                texts, index, LATEST_ALLOW_MARKER
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

            if has_inline_or_previous_marker(texts, index, DOWNLOAD_ALLOW_MARKER):
                continue

            if is_post_only_webhook(line):
                continue

            if has_local_url(line):
                continue

            if not has_nearby_verification(texts, index):
                failures.append(
                    format_failure(
                        relative_path,
                        line_number,
                        "remote download without checksum/signature verification or allow marker",
                        line,
                    )
                )

    return failures


def fold_continuations(lines: list[str]) -> list[tuple[int, str]]:
    """Join backslash-continued physical lines into logical lines so multi-line
    commands are matched whole; each logical line keeps its first physical
    line's number for reporting. Comment lines never continue."""
    folded: list[tuple[int, str]] = []
    index = 0
    while index < len(lines):
        start_line_number = index + 1
        line = lines[index]
        while ends_with_continuation(line) and index + 1 < len(lines):
            line = line[:-1].rstrip() + " " + lines[index + 1].strip()
            index += 1
        folded.append((start_line_number, line))
        index += 1
    return folded


def ends_with_continuation(line: str) -> bool:
    # Shell semantics: only an odd count of trailing backslashes continues the
    # line (an even count is escaped literal backslashes), and the backslash
    # must be the final character — no trailing whitespace after it.
    if not line.endswith("\\") or line.strip().startswith("#"):
        return False
    trailing_backslashes = len(line) - len(line.rstrip("\\"))
    return trailing_backslashes % 2 == 1


def iter_candidate_files(repo_root: Path):
    yield from sorted((repo_root / ".github").rglob("*.yml"))
    yield from sorted((repo_root / ".github").rglob("*.yaml"))
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
    # Only the pre-comment part of the line counts: a POST flag mentioned in a
    # trailing comment must not exempt an actual download on the same line.
    code = re.split(r"\s#", line, maxsplit=1)[0]
    return "curl" in code and bool(
        re.search(r"(?:-X\s*|--request(?:=|\s+))POST\b", code, re.IGNORECASE)
    )


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
    if any(marker in window for marker in verification_markers):
        return True
    # A bare `openssl dgst` only prints a hash; it counts as verification only
    # next to an actual pass/fail check: a signature check (-verify) or a
    # comparison of the digest against a pinned value (test "$X" = "$Y").
    return "openssl dgst" in window and (
        "-verify" in window
        or re.search(r'\btest\s+"[^"]*"\s*==?\s', window) is not None
    )


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
