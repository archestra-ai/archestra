#!/usr/bin/env python3
"""Choose the release images the nightly scan rebuilds on each supported line.

Each line keeps its own image inventory, so a branch's images come from that
branch's own release-image policy and agent catalog, read from its commit.
"""

import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile


def scan_targets(root):
    """Return one matrix row per release image on main and each supported line."""
    rows = []
    for branch in ["main", *release_branches(root)]:
        sha = git(root, "rev-parse", "--verify", f"refs/remotes/origin/{branch}^{{commit}}")
        if not SHA.fullmatch(sha):
            raise ValueError(f"Cannot resolve {branch}")
        for image in branch_inventory(root, sha):
            if branch == "main" and image["image"] in COVERED_ON_MAIN:
                continue
            rows.append({"branch": branch, "sha": sha} | image)
    if not rows:
        raise ValueError("No release images to scan")
    return {"include": rows}


def main():
    if sys.argv[1:] != ["targets"]:
        raise SystemExit("usage: nightly-release-image-scan.py targets")
    matrix = scan_targets(Path.cwd())
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"matrix={json.dumps(matrix, separators=(',', ':'))}\n")
    for row in matrix["include"]:
        print(f"{row['branch']} {row['sha'][:12]} {row['image']}")


# ============================================================================
# Internal helpers
# ============================================================================


def release_branches(root):
    branches = json.loads((root / ".github/backport-targets.json").read_text())["branches"]
    if not all(isinstance(branch, str) and RELEASE_BRANCH.fullmatch(branch) for branch in branches):
        raise ValueError("Invalid release branch in .github/backport-targets.json")
    if len(branches) != len(set(branches)):
        raise ValueError("Duplicate release branch in .github/backport-targets.json")
    return branches


def branch_inventory(root, sha):
    """Run the branch's own candidate_matrix against that branch's files."""
    archive = subprocess.run(["git", "-C", str(root), "archive", "--format=tar", sha, *INVENTORY_PATHS],
                             check=True, capture_output=True).stdout
    with tempfile.TemporaryDirectory() as tree:
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(tree, filter="data")
        spec = importlib.util.spec_from_file_location(
            f"release_image_policy_{sha}", Path(tree) / ".github/scripts/release-image-policy.py")
        policy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(policy)
        return policy.candidate_matrix(Path(tree))["include"]


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


RELEASE_BRANCH = re.compile(r"release/[0-9]+\.[0-9]+")
SHA = re.compile(r"[0-9a-f]{40}")
# nightly-platform-image-byte-scan.yml already scans main's Platform full and slim bytes.
COVERED_ON_MAIN = frozenset({"platform", "platform-slim"})
# Everything candidate_matrix reads: the policy itself, the agent catalog, and
# the Dockerfiles it checks exist.
INVENTORY_PATHS = (
    ".github/scripts/release-image-policy.py",
    "platform/shared/agent-catalog-images.json",
    "platform/Dockerfile",
    "platform/docker_images",
)


if __name__ == "__main__":
    main()
