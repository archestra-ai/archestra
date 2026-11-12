"""Require a version bump when a change reaches the archestra binary.

`archestra` (platform/archestra-cli) is released by build-archestra-cli.yml as
`archestra-cli-v<version>`, and a release cannot be changed once published. A
change merged under a version that is already released would never reach the
users: the release build finds the release and skips.

Usage:
  archestra-cli-version-check.py check BASE HEAD   exit 1 when a bump is missing
  archestra-cli-version-check.py version [REF]     print the version at REF, or
                                                   of the working tree
"""

import os
import re
import subprocess
import sys
import tomllib

PROGRAM = "platform/archestra-cli/"
MANIFEST = PROGRAM + "Cargo.toml"
TAG_PREFIX = "archestra-cli-v"


def binary_input(path):
    """Whether a change to this file can change the released binary.

    A skip list inside the program's directory: prose, the tests and the
    release lock never reach the binary. Everything else there counts, so a
    new build.rs or .cargo/config.toml needs no change here.

    platform/rust-toolchain.toml does not count, though it pins the compiler:
    the rest of the platform shares it, and a new compiler alone must not
    make each device download a program that did not change. The next change
    of the program is built with the compiler of that day.
    """
    if not path.startswith(PROGRAM):
        return False
    rest = path[len(PROGRAM):]
    return not (rest.endswith(".md") or rest.startswith("tests/") or rest == "release.lock.json")


def parse_name_status(output):
    """Entries of `git diff --name-status -M -z`: (status, [paths])."""
    fields = [field for field in output.split("\0") if field]
    entries = []
    index = 0
    while index < len(fields):
        status = fields[index]
        count = 2 if status[0] in "RC" else 1
        entries.append((status, fields[index + 1:index + 1 + count]))
        index += 1 + count
    return entries


def changed_inputs(entries):
    """The binary inputs among the changed paths, sorted.

    A pure rename (R100) moves a file with no change to its content and is
    exempt. A rename that also edits the file counts under both names: leaving
    the inputs changes the binary as much as entering them.
    """
    changed = set()
    for status, paths in entries:
        if status == "R100":
            continue
        changed.update(path for path in paths if binary_input(path))
    return sorted(changed)


def package_version(manifest):
    """`[package] version` of a Cargo.toml text."""
    version = tomllib.loads(manifest).get("package", {}).get("version")
    if not isinstance(version, str) or not version:
        raise ValueError(f"{MANIFEST} has no [package] version string")
    return version


def tag(version):
    return TAG_PREFIX + version


def next_version(version):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
    return f"{match[1]}.{match[2]}.{int(match[3]) + 1}" if match else None


def verdict(changed, version, released):
    """(passed, message) for the changed binary inputs and the head version.

    `version` is None when the program no longer exists at head.
    """
    if not changed:
        return True, "No change reaches the archestra binary; no version bump is needed."
    if version is None:
        return True, f"{MANIFEST} is gone at head; there is nothing to release."
    if not released:
        return True, (
            f"archestra {version} is not released yet (no {tag(version)}); "
            "these changes ship with it."
        )
    example = next_version(version)
    example = f' (for example to "{example}")' if example else ""
    files = "\n".join(f"  {path}" for path in changed)
    return False, (
        f"The archestra program changed, but its version {version} is already released as "
        f"{tag(version)}.\n"
        "A release cannot be changed, and the release build skips a version that is already "
        "published, so this change would never reach the users.\n"
        "\n"
        f"Changed files that go into the binary:\n{files}\n"
        "\n"
        "What to do:\n"
        f"  1. Raise `version` under [package] in {MANIFEST}{example}.\n"
        f"  2. Run `cargo check` in {PROGRAM.rstrip('/')}: it writes the new version to Cargo.lock, "
        "and the release build uses --locked.\n"
        "  3. Commit Cargo.toml and Cargo.lock."
    )


def git(*args):
    return subprocess.check_output(["git", *args]).decode("utf-8", errors="surrogateescape")


def version_at(ref):
    """The version at a commit, or None when the program does not exist there."""
    exists = subprocess.run(
        ["git", "cat-file", "-e", f"{ref}:{MANIFEST}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode == 0
    return package_version(git("show", f"{ref}:{MANIFEST}")) if exists else None


def is_released(version, repository):
    """Whether the release or its tag exists.

    Only "not found" means unreleased. Any other answer stops the check: a
    failed request must not pass an unbumped change.
    """
    for path in (
        f"repos/{repository}/releases/tags/{tag(version)}",
        f"repos/{repository}/git/ref/tags/{tag(version)}",
    ):
        result = subprocess.run(["gh", "api", path, "--silent"], capture_output=True, text=True)
        if result.returncode == 0:
            return True
        if "HTTP 404" not in result.stderr:
            raise SystemExit(f"Could not read {path} from GitHub: {result.stderr.strip()}")
    return False


def check(base, head):
    changed = changed_inputs(parse_name_status(git("diff", "--name-status", "-M", "-z", base, head)))
    version = version_at(head) if changed else None
    released = bool(changed) and version is not None and is_released(
        version, os.environ.get("GITHUB_REPOSITORY", "archestra-ai/archestra")
    )
    passed, message = verdict(changed, version, released)
    if passed:
        print(message)
        return 0
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::error title=Version bump required::{message.splitlines()[0]} "
              f"Raise `version` in {MANIFEST} and update Cargo.lock.")
    print(message, file=sys.stderr)
    return 1


def main(argv):
    if len(argv) == 3 and argv[0] == "check":
        return check(argv[1], argv[2])
    if len(argv) in (1, 2) and argv[0] == "version":
        if len(argv) == 2:
            version = version_at(argv[1])
            if version is None:
                raise SystemExit(f"{MANIFEST} does not exist at {argv[1]}")
        else:
            with open(os.path.join(os.path.dirname(__file__), "..", "..", MANIFEST), encoding="utf-8") as manifest:
                version = package_version(manifest.read())
        print(version)
        return 0
    print(__doc__.strip(), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
