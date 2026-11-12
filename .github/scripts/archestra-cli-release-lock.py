"""Write platform/archestra-cli/release.lock.json for one archestra release.

The lock pins the release that every platform image carries: its version, the
URL of its files and the SHA-256 of each. The archestra-cli-release stage of
platform/Dockerfile downloads exactly these files and fails on a mismatch.

Usage:
  archestra-cli-release-lock.py --version 0.2.0 --dir DIR
  archestra-cli-release-lock.py --version 0.2.0 --sums SHA256SUMS

DIR holds the six built files and nothing else, except a SHA256SUMS file,
which must then agree with them. Either way all six files must be present and
no other name is accepted. The output is the same for the same input: sorted
keys, two-space indentation, one newline at the end.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / "platform/archestra-cli/release.lock.json"
SUMS = "SHA256SUMS"
# The names the backend serves: archestra-<system>-<cpu>, .exe on Windows.
FILES = tuple(sorted(
    f"archestra-{system}-{cpu}{'.exe' if system == 'windows' else ''}"
    for system in ("darwin", "linux", "windows")
    for cpu in ("arm64", "x86_64")
))
VERSION = re.compile(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?")
SHA256 = re.compile(r"[0-9a-f]{64}")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
# The lock before the first release: images then carry no program.
EMPTY = {"version": None, "url": None, "files": {}}


def parse_sums(text):
    """Checksums by name from `sha256sum` output."""
    checksums = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line)
        if not match:
            raise ValueError(f"Not a `sha256sum` line: {line!r}")
        if match[2] in checksums:
            raise ValueError(f"{match[2]} is listed twice")
        checksums[match[2]] = match[1]
    return checksums


def hash_directory(directory):
    """Checksums by name of the files in a directory, checked against its SHA256SUMS if any."""
    directory = Path(directory)
    entries = sorted(directory.iterdir())
    other = [entry.name for entry in entries if not entry.is_file() or entry.is_symlink()]
    if other:
        raise ValueError(f"Not a regular file: {', '.join(other)}")
    checksums = {
        entry.name: hashlib.sha256(entry.read_bytes()).hexdigest()
        for entry in entries if entry.name != SUMS
    }
    listed = directory / SUMS
    if listed.exists() and parse_sums(listed.read_text()) != checksums:
        raise ValueError(f"{SUMS} does not agree with the files next to it")
    return checksums


def build(version, checksums, repository="archestra-ai/archestra"):
    """The lock for a version and the checksums of exactly the six files."""
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError(f"Version must look like 1.2.3, got {version!r}")
    if not REPOSITORY.fullmatch(repository):
        raise ValueError(f"Repository must look like owner/name, got {repository!r}")
    missing = sorted(set(FILES) - set(checksums))
    unexpected = sorted(set(checksums) - set(FILES))
    if missing or unexpected:
        problems = []
        if missing:
            problems.append(f"missing: {', '.join(missing)}")
        if unexpected:
            problems.append(f"unexpected: {', '.join(unexpected)}")
        raise ValueError(f"A release has exactly these files: {', '.join(FILES)}. " + "; ".join(problems))
    bad = sorted(name for name, checksum in checksums.items() if not SHA256.fullmatch(str(checksum)))
    if bad:
        raise ValueError(f"Not a SHA-256 in lowercase hex: {', '.join(bad)}")
    return {
        "version": version,
        "url": f"https://github.com/{repository}/releases/download/archestra-cli-v{version}",
        "files": dict(checksums),
    }


def render(lock):
    return json.dumps(lock, indent=2, sort_keys=True) + "\n"


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--version", required=True, help="the released version, without the tag prefix")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--dir", help="directory with the six built files")
    source.add_argument("--sums", help="SHA256SUMS file of the release")
    parser.add_argument("--repository", default="archestra-ai/archestra", help="owner/name that holds the release")
    parser.add_argument("--output", default=str(LOCK), help="lock file to write (default: %(default)s)")
    args = parser.parse_args(argv)
    try:
        checksums = hash_directory(args.dir) if args.dir else parse_sums(Path(args.sums).read_text())
        lock = build(args.version, checksums, args.repository)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    Path(args.output).write_text(render(lock))
    print(f"Wrote {args.output} for archestra {args.version}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
