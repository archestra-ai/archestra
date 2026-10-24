#!/usr/bin/env python3
"""Classify release PRs and fail closed before reporting required checks."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlencode


SHA = re.compile(r"[0-9a-f]{40}")


def queue_versions(group):
    path = ".github/release-please/.release-please-manifest.json"
    return [json.loads(subprocess.check_output(
        ["git", "show", f"{group[key]}:{path}"], text=True,
    ))["platform"] for key in ("base_sha", "head_sha")]


def queue_candidate(event):
    group = event["merge_group"]
    branch = group["base_ref"].removeprefix("refs/heads/")
    if group["base_ref"] != f"refs/heads/{branch}":
        raise ValueError("Missing queue base branch")
    if branch != "main" and not re.fullmatch(r"release/[0-9]+\.[0-9]+", branch):
        return False
    if not all(SHA.fullmatch(group[key]) for key in ("head_sha", "base_sha")):
        raise ValueError("Missing exact merge group revisions")
    if not group["head_ref"].startswith(f"refs/heads/gh-readonly-queue/{branch}/"):
        raise ValueError("Unexpected merge group ref")
    # Inspect the complete combined group, not the PR encoded in a queue branch
    # name. Any version change requires scans, including mixed release/feature
    # groups. Missing revisions/manifests fail closed in queue_versions.
    before, after = queue_versions(group)
    if not all(isinstance(version, str) and version for version in (before, after)):
        raise ValueError("Missing queue release versions")
    return before != after


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


def is_release_pr(pr, repository):
    head, base = pr["head"], pr["base"]
    if not head["ref"].startswith("release-please--"):
        return False
    if base["ref"] != "main" and not re.fullmatch(r"release/[0-9]+\.[0-9]+", base["ref"]):
        raise ValueError("Release PR must target main or release/X.Y")
    if head["ref"] != f"release-please--branches--{base['ref']}--components--platform":
        raise ValueError("Unexpected Release Please branch")
    if head["repo"]["full_name"] != repository or base["repo"]["full_name"] != repository:
        raise ValueError("Release PR must originate in this repository")
    if not SHA.fullmatch(head["sha"]):
        raise ValueError("Missing exact release PR head revision")
    return True


def requires_scan(event_name, event, repository):
    if event_name == "merge_group":
        return queue_candidate(event)
    if event_name == "workflow_dispatch":
        return False
    if event_name != "pull_request":
        raise ValueError(f"Unsupported event: {event_name}")
    is_release_pr(event["pull_request"], repository)
    # The required PR contexts remain present, but only the immutable merge
    # group builds and scans release candidates for publication.
    return False


def validate_gate(event_name, event, repository, classify_result, decision, scan_result, current=None,
                  workflow_sha=None):
    if classify_result != "success":
        raise ValueError("Release classification did not succeed")
    required = requires_scan(event_name, event, repository)
    if event_name == "merge_group" and workflow_sha != event["merge_group"]["head_sha"]:
        raise ValueError("Workflow revision differs from the classified merge group")
    if decision != str(required).lower():
        raise ValueError("Missing or inconsistent scan decision")
    if not required:
        if scan_result != "skipped":
            raise ValueError("Unexpected scan result for an ordinary event")
        return
    if scan_result != "success":
        raise ValueError(f"Every release image scan must succeed (got {scan_result!r})")
    group = event["merge_group"]
    if workflow_sha != group["head_sha"] or current != group["head_sha"]:
        raise ValueError("Merge group changed or scans belong to another queue revision")


def queue_release_pr(event, repository, prs):
    group = event["merge_group"]
    if len(prs) != 1 or not is_release_pr(prs[0], repository):
        raise ValueError("Queue version change requires exactly one open Release Please PR")
    pr = prs[0]
    if pr["state"] != "open" or group["base_ref"] != f"refs/heads/{pr['base']['ref']}":
        raise ValueError("Release PR target changed during queue scanning")
    return pr


def queue_release_tree(event, repository, prs):
    pr = queue_release_pr(event, repository, prs)
    # GitHub computes merge_commit_sha asynchronously. It may be absent or refer
    # to an older test merge even when head/base are current. Reconstruct from
    # those immutable commits without touching the checked-out/scanned files.
    try:
        tree = subprocess.check_output(
            ["git", "merge-tree", "--write-tree", event["merge_group"]["base_sha"], pr["head"]["sha"]],
            text=True, stderr=subprocess.PIPE,
        ).strip()
    except subprocess.CalledProcessError as error:
        raise ValueError(f"Cannot reconstruct release PR #{pr['number']} from base "
                         f"{event['merge_group']['base_sha']} and head {pr['head']['sha']}; "
                         "merge conflicts or missing Git objects") from error
    if not SHA.fullmatch(tree):
        raise ValueError("Release merge reconstruction did not return one immutable tree")
    return tree


def validate_queue_release_source(event, repository, prs, release_tree, group_tree):
    pr = queue_release_pr(event, repository, prs)
    if not SHA.fullmatch(release_tree or "") or release_tree != group_tree:
        raise ValueError("Mixed queue group differs from the release merge candidate; "
                         f"PR #{pr['number']} base={event['merge_group']['base_sha']} head={pr['head']['sha']} "
                         f"release_tree={release_tree} group_tree={group_tree}; "
                         "validate the release in its own group")


def recheck_queue_release_source(event, repository, expected):
    current = json.loads(subprocess.check_output(
        ["gh", "api", f"repos/{repository}/pulls/{int(expected['number'])}"], text=True,
    ))
    queue_release_pr(event, repository, [current])
    if current["number"] != expected["number"] or any(
        current[field][key] != expected[field][key]
        for field, key in (("head", "sha"), ("head", "ref"), ("base", "ref"))
    ):
        raise ValueError("Release PR changed during queue source validation")
    ref = event["merge_group"]["head_ref"].removeprefix("refs/")
    live = json.loads(subprocess.check_output(
        ["gh", "api", f"repos/{repository}/git/ref/{ref}"], text=True,
    ))["object"]["sha"]
    if live != event["merge_group"]["head_sha"]:
        raise ValueError("Merge group changed during queue source validation")


def main():
    mode = sys.argv[1]
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    event_name, repository = os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REPOSITORY"]
    if mode == "classify":
        decision = requires_scan(event_name, event, repository)
        inventory = candidate_matrix(Path(__file__).resolve().parents[2])
        matrix = {"include": [row | {"arch": arch} for row in inventory["include"]
                              for arch in ("amd64", "arm64")]}
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"scan={str(decision).lower()}\n")
            output.write(f"matrix={json.dumps(matrix, separators=(',', ':'))}\n")
    elif mode == "gate":
        required = requires_scan(event_name, event, repository)
        current = None
        queue_source = None
        if required and os.environ["SCAN_RESULT"] == "success":
            if event_name == "merge_group":
                ref = event["merge_group"]["head_ref"].removeprefix("refs/")
                current = json.loads(subprocess.check_output(
                    ["gh", "api", f"repos/{repository}/git/ref/{ref}"], text=True,
                ))["object"]["sha"]
            else:
                current = json.loads(subprocess.check_output(
                    ["gh", "api", f"repos/{repository}/pulls/{int(event['pull_request']['number'])}"], text=True,
                ))
        validate_gate(event_name, event, repository, os.environ["CLASSIFY_RESULT"],
                      os.environ["SCAN_REQUIRED"], os.environ["SCAN_RESULT"], current,
                      os.environ["GITHUB_SHA"])
        if required and event_name == "merge_group":
            branch = event["merge_group"]["base_ref"].removeprefix("refs/heads/")
            head = f"{repository.split('/')[0]}:release-please--branches--{branch}--components--platform"
            query = urlencode({"state": "open", "base": branch, "head": head, "per_page": 100})
            prs = json.loads(subprocess.check_output(["gh", "api", f"repos/{repository}/pulls?{query}"], text=True))
            release_tree = queue_release_tree(event, repository, prs)
            group_tree = subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], text=True).strip()
            validate_queue_release_source(event, repository, prs, release_tree, group_tree)
            queue_source = prs[0]
            print(f"Queue release source: PR #{queue_source['number']} "
                  f"base={event['merge_group']['base_sha']} head={queue_source['head']['sha']} "
                  f"release_tree={release_tree} group_tree={group_tree}")
        if required:
            import importlib.util
            spec = importlib.util.spec_from_file_location("candidate", Path(__file__).with_name("release-candidate.py"))
            candidate = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(candidate)
            records = candidate.validate_evidence(Path(os.environ["EVIDENCE_DIR"]),
                                                 candidate_matrix(Path(__file__).resolve().parents[2]))
            if queue_source is not None:
                recheck_queue_release_source(event, repository, queue_source)
            branch = (event["merge_group"]["base_ref"].removeprefix("refs/heads/") if event_name == "merge_group"
                      else event["pull_request"]["base"]["ref"])
            index = {"schema": 1, **candidate.identity(), "branch": branch, "records": records,
                     "created_at": candidate.dt.datetime.now(candidate.dt.timezone.utc).isoformat()}
            if queue_source is not None:
                index["queue_release_source"] = {"number": queue_source["number"],
                    "head_sha": queue_source["head"]["sha"], "base_sha": event["merge_group"]["base_sha"],
                    "tree": release_tree}
            output = Path(os.environ["CANDIDATE_INDEX"])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(index))
        print("Release images scanned for the current candidate." if required else
              "No release image scan required for this event; publication scans its own artifacts.")
    else:
        raise ValueError(f"Unsupported mode: {mode}")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"Release image security gate failed: {error}")
