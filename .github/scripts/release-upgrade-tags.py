"""Print the release tags the migration upgrade replay reads, one per line.

platform/backend/scripts/migration-tag-upgrades.test.mjs migrates from the
newest stable platform-vX.Y.Z tag of each fetched release/X.Y branch. Fetching
only those tags, instead of every platform-v* tag, keeps the lint job from
downloading one tree per historical release.

Usage: git ls-remote --refs --tags <remote> 'platform-v*' | release-upgrade-tags.py
The release lines come from the already fetched refs/remotes/origin/release/*.
"""

import re
import subprocess
import sys


def latest_stable_tags(remote_tags, release_lines):
    newest = {}
    for tag in remote_tags:
        match = re.fullmatch(r"platform-v(\d+)\.(\d+)\.(\d+)", tag)
        if not match:
            continue
        line = f"{match[1]}.{match[2]}"
        version = tuple(int(part) for part in match.groups())
        if line in release_lines and (line not in newest or version > newest[line][0]):
            newest[line] = (version, tag)
    return sorted(tag for _, tag in newest.values())


def parse_ls_remote(lines):
    prefix = "refs/tags/"
    return [
        ref[len(prefix):]
        for ref in (line.split("\t", 1)[-1].strip() for line in lines)
        if ref.startswith(prefix)
    ]


def fetched_release_lines():
    refs = subprocess.check_output(
        ["git", "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/release/"]
    ).decode().split()
    return {match[1] for ref in refs if (match := re.fullmatch(r"origin/release/(\d+\.\d+)", ref))}


if __name__ == "__main__":
    # No fetched release branch selects nothing: a private mirror's own origin
    # has none and fetches the canonical lines in a later step, and the replay
    # test itself fails when no stable tag exists at all.
    for tag in latest_stable_tags(parse_ls_remote(sys.stdin), fetched_release_lines()):
        print(tag)
