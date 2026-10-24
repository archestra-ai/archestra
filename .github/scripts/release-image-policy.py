#!/usr/bin/env python3
"""Classify release PRs and fail closed before reporting required checks."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys


SHA = re.compile(r"[0-9a-f]{40}")


def candidate_matrix(root):
    """Scan every maintained catalog target, including this branch's inventory."""
    platform = root / "platform"
    images = [
        {"image": "platform", "context": "./platform", "dockerfile": "./platform/Dockerfile", "target": ""},
        {"image": "platform-slim", "context": "./platform", "dockerfile": "./platform/Dockerfile", "target": "unified-slim"},
    ]
    for image, directory in (("mcp-server-base", "mcp_server"), ("p4-shim", "p4_shim"),
                             ("sandbox-base", "sandbox_base")):
        context = f"./platform/docker_images/{directory}"
        images.append({"image": image, "context": context, "dockerfile": f"{context}/Dockerfile", "target": ""})
    catalog = json.loads((platform / "shared/agent-catalog-images.json").read_text())
    if not isinstance(catalog, dict) or not catalog:
        raise ValueError("Missing published agent inventory")
    targets = list(catalog.values())
    if (not all(isinstance(target, str) and re.fullmatch(r"agent-[a-z0-9-]+", target) for target in targets)
            or len(targets) != len(set(targets))):
        raise ValueError("Invalid or duplicate agent image targets")
    dockerfile = platform / "docker_images/agent/Dockerfile"
    stages = set(re.findall(r"^FROM\s+.+\s+AS\s+(\S+)\s*$", dockerfile.read_text(), re.M | re.I))
    for target in targets:
        if target not in stages:
            raise ValueError(f"Published agent target has no Dockerfile stage: {target}")
        images.append({"image": target, "context": "./platform",
                       "dockerfile": "./platform/docker_images/agent/Dockerfile", "target": target})
    for image in images:
        if not (root / image["dockerfile"]).is_file():
            raise ValueError(f"Missing image Dockerfile: {image['dockerfile']}")
    return {"include": images}


def requires_scan(event_name, event, repository):
    if event_name in ("merge_group", "workflow_dispatch"):
        return False
    if event_name != "pull_request":
        raise ValueError(f"Unsupported event: {event_name}")
    pr = event["pull_request"]
    head, base = pr["head"], pr["base"]
    if not head["ref"].startswith("release-please--"):
        return False
    if base["ref"] != "main" and not re.fullmatch(r"release/[0-9]+\.[0-9]+", base["ref"]):
        raise ValueError("Release PR must target main or release/X.Y")
    if head["ref"] != f"release-please--branches--{base['ref']}--components--platform":
        raise ValueError("Unexpected Release Please branch")
    if head["repo"]["full_name"] != repository or base["repo"]["full_name"] != repository:
        raise ValueError("Release PR must originate in this repository")
    if not all(SHA.fullmatch(ref["sha"]) for ref in (head, base)):
        raise ValueError("Missing exact release PR revisions")
    return True


def validate_gate(event_name, event, repository, classify_result, decision, scan_result, current=None,
                  workflow_sha=None):
    if classify_result != "success":
        raise ValueError("Release classification did not succeed")
    required = requires_scan(event_name, event, repository)
    if decision != str(required).lower():
        raise ValueError("Missing or inconsistent scan decision")
    if not required:
        if scan_result != "skipped":
            raise ValueError("Unexpected scan result for an ordinary event")
        return
    if scan_result != "success":
        raise ValueError(f"Every release image scan must succeed (got {scan_result!r})")
    expected = event["pull_request"]
    if current is None or current["state"] != "open" or current["number"] != expected["number"]:
        raise ValueError("Release PR is no longer open or could not be verified")
    if not requires_scan("pull_request", {"pull_request": current}, repository):
        raise ValueError("Current PR is no longer a release PR")
    for field in ("head", "base"):
        for key in ("sha", "ref"):
            if current[field][key] != expected[field][key]:
                raise ValueError("Release PR or base changed during scanning; rerun on the current revision")
    # The event payload's merge_commit_sha can predate GitHub's recomputed test
    # merge, so bind the scanned commit to the PR's live merge candidate instead.
    if not SHA.fullmatch(workflow_sha or "") or current["merge_commit_sha"] != workflow_sha:
        raise ValueError("Scans are not associated with the release PR's current merge candidate")


def main():
    mode = sys.argv[1]
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    event_name, repository = os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REPOSITORY"]
    if mode == "classify":
        decision = requires_scan(event_name, event, repository)
        matrix = candidate_matrix(Path(__file__).resolve().parents[2])
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"scan={str(decision).lower()}\n")
            output.write(f"matrix={json.dumps(matrix, separators=(',', ':'))}\n")
    elif mode == "gate":
        required = requires_scan(event_name, event, repository)
        current = None
        if required and os.environ["SCAN_RESULT"] == "success":
            current = json.loads(subprocess.check_output(
                ["gh", "api", f"repos/{repository}/pulls/{int(event['pull_request']['number'])}"], text=True,
            ))
        validate_gate(event_name, event, repository, os.environ["CLASSIFY_RESULT"],
                      os.environ["SCAN_REQUIRED"], os.environ["SCAN_RESULT"], current,
                      os.environ["GITHUB_SHA"])
        print("Release images scanned for the current candidate." if required else
              "No release image scan required for this event; publication scans its own artifacts.")
    else:
        raise ValueError(f"Unsupported mode: {mode}")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"Release image security gate failed: {error}")
