#!/usr/bin/env python3
"""Release version requests and publication checks. Uses only Python's standard library."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path


def version(value):
    match = re.fullmatch(
        r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?", value
    )
    if not match:
        raise ValueError("Expected X.Y.Z or X.Y.Z-rc.N, without a tag prefix")
    return tuple(int(part) if part is not None else None for part in match.groups())


def validate_request(branch, current, requested):
    old = version(current)
    new = version(requested)
    if branch != f"release/{new[0]}.{new[1]}":
        raise ValueError(
            "Release version must match the release/X.Y branch; main cannot release"
        )
    if current == requested:
        return  # A merged release-please PR is ready to build, not another version request.
    if old[3] is not None:
        allowed = new[:3] == old[:3] and new[3] in (None, old[3] + 1)
    elif old[:2] == new[:2]:
        allowed = new == (old[0], old[1], old[2] + 1, None)
    else:
        next_line = new[:2] in ((old[0], old[1] + 1), (old[0] + 1, 0))
        allowed = next_line and new[2:] == (0, 1)
    if not allowed:
        raise ValueError(
            "Request the next patch, next minor/major rc.1, next RC, or that RC's stable version"
        )


def validate_supported(requested, latest):
    new, stable = version(requested), version(latest)
    if stable[3] is not None:
        raise ValueError("Latest supported release must be stable")
    if new[:2] == stable[:2]:
        # A rejected draft consumes a version number; its replacement may skip it.
        allowed = new[3] is None and new[2] >= stable[2]
    else:
        allowed = new[:2] in ((stable[0], stable[1] + 1), (stable[0] + 1, 0))
    if not allowed:
        raise ValueError(
            "Only the supported stable line or the next feature line may release"
        )


def validate_publication(*, requested, latest, branch, tag_sha, run, release):
    validate_request(branch, requested, requested)
    validate_supported(requested, latest)
    if version(requested)[3] is not None:
        raise ValueError("RCs cannot be promoted to the stable channel")
    if release["tag_name"] != f"platform-v{requested}" or release["prerelease"]:
        raise ValueError("Release metadata does not match the requested stable version")
    if not release["draft"] and requested != latest:
        raise ValueError("Cannot republish a retired release")
    if (
        run["path"] != ".github/workflows/release-please.yml"
        or run["head_branch"] != branch
        or run["head_sha"] != tag_sha
        or run["event"] not in ("push", "workflow_dispatch")
        or run["status"] != "completed"
        or run["conclusion"] != "success"
    ):
        raise ValueError(
            "Require a successful Release Please build for this exact release commit and branch"
        )


def validate_qualification(issue, requested, latest, manifest_sha256):
    body = issue.get("body") or ""
    if issue.get("pull_request"):
        raise ValueError("Use a Release Qualification issue, not a PR")
    for heading, expected in (
        ("Stable version", requested),
        ("Artifact manifest SHA-256", manifest_sha256),
    ):
        if not re.search(
            rf"(?m)^### {heading}\s+{re.escape(expected)}\s*(?=\n### |\Z)", body
        ):
            raise ValueError(
                f"Qualification record has a missing or mismatched {heading}"
            )
    if requested != latest and not re.search(
        rf"(?m)^### Upgrade source version\s+{re.escape(latest)}\s*(?=\n### |\Z)", body
    ):
        raise ValueError(
            "Repeat upgrade qualification from the current supported stable patch"
        )
    checklist = (
        "Final image digests and chart archive match the recorded manifest.",
        "Fresh installation passes with beta disabled and no experimental opt-ins.",
        "Populated upgrade preserves data and access restrictions.",
        "Core workflows and changed paths pass on supported deployment modes.",
        "Migration safety and recovery were reviewed and exercised where applicable.",
        "Representative use shows no release-blocking errors or resource regressions.",
        "Evidence contains no private information.",
    )
    for item in checklist:
        if not re.search(rf"(?m)^- \[[xX]\] {re.escape(item)}\s*$", body):
            raise ValueError(f"Incomplete qualification: {item}")


def check_pr(event):
    pr = event.get("pull_request")
    if not pr or not pr["base"]["ref"].startswith("release/"):
        return
    branch = pr["base"]["ref"]
    base, head = pr["base"]["sha"], pr["head"]["sha"]

    def read_json(ref, path):
        return json.loads(
            subprocess.check_output(["git", "show", f"{ref}:{path}"], text=True)
        )

    directory = ".github/release-please"
    current = read_json(base, f"{directory}/.release-please-manifest.json")["platform"]
    config = read_json(head, f"{directory}/release-please-config.json")["packages"][
        "platform"
    ]
    requested = config.get("release-as", current)
    validate_request(branch, current, requested)
    if re.match(r"(?:feat|refactor)(?:\(|:|!)", pr["title"]) or re.match(
        r"\w+(?:\([^)]*\))?!:", pr["title"]
    ):
        raise ValueError(
            "Release branches accept stabilization and bug fixes, not features, refactors, or breaking changes"
        )
    files = subprocess.check_output(
        ["git", "diff", "--name-only", f"{base}...{head}"], text=True
    ).splitlines()
    if (
        version(requested)[3] is None
        and version(current)[3] is None
        and any(
            path.startswith(
                (
                    "platform/backend/src/database/migrations/",
                    "platform/backend/src/database/schemas/",
                )
            )
            for path in files
        )
    ):
        raise ValueError(
            "Stable patches cannot change schema or migration history; qualify a feature release"
        )
    metadata = {
        f"{directory}/release-please-config.json",
        f"{directory}/.release-please-manifest.json",
        "platform/CHANGELOG.md",
        "platform/package.json",
        "platform/backend/package.json",
        "platform/frontend/package.json",
        "platform/shared/package.json",
        "platform/pnpm-lock.yaml",
        "platform/helm/archestra/values.yaml",
        "platform/docs/openapi.json",
        "docs/openapi.json",
    }
    if set(files) <= metadata:
        return  # Version/configuration PRs still require maintainer review.
    if version(current)[3] is not None and version(requested)[3] is None:
        raise ValueError(
            "Final-version requests must not contain product changes; first qualify another RC"
        )
    originals = re.findall(r"(?m)^Backport-of: ([0-9a-f]{40})$", pr.get("body") or "")
    if not originals:
        raise ValueError(
            "Release branch changes require Backport-of: <full main commit SHA> in the PR body"
        )
    for original in originals:
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", original, "origin/main"], check=True
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "check-pr", help="Validate release branch PR scope and backport references"
    )
    prepare = commands.add_parser(
        "prepare", help="Write a version request locally; never commits or pushes"
    )
    prepare.add_argument("version")
    prepare.add_argument(
        "--branch",
        required=True,
        help="Target release/X.Y branch, not the PR head branch",
    )
    check = commands.add_parser("check", help="Validate the branch's release request")
    check.add_argument("--branch", required=True)
    check.add_argument("--latest", required=True)
    publication = commands.add_parser("check-publication")
    publication.add_argument("--version", required=True)
    publication.add_argument("--latest", required=True)
    publication.add_argument("--branch", required=True)
    publication.add_argument("--tag-sha", required=True)
    publication.add_argument("--run", type=Path, required=True)
    publication.add_argument("--release", type=Path, required=True)
    publication.add_argument("--qualification", type=Path, required=True)
    publication.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    if args.command == "check-pr":
        check_pr(json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()))
        return
    if args.command == "check-publication":
        validate_publication(
            requested=args.version,
            latest=args.latest,
            branch=args.branch,
            tag_sha=args.tag_sha,
            run=json.loads(args.run.read_text()),
            release=json.loads(args.release.read_text()),
        )
        validate_qualification(
            json.loads(args.qualification.read_text()),
            args.version,
            args.latest,
            args.manifest_sha256,
        )
        return
    root = Path(
        subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True
        ).strip()
    )
    directory = root / ".github/release-please"
    config_path = directory / "release-please-config.json"
    config = json.loads(config_path.read_text())
    package = config["packages"]["platform"]
    current = json.loads((directory / ".release-please-manifest.json").read_text())[
        "platform"
    ]
    if args.command == "prepare":
        validate_request(args.branch, current, args.version)
        if current == args.version:
            raise ValueError(
                "This version is already in the manifest; request a new version"
            )
        # The previous stable tag may live on a sibling release branch. Bound the
        # first RC's changelog at the common ancestor, not at an unreachable tag.
        # Refresh this on EVERY request so later RCs/patches use their own tag.
        config["last-release-sha"] = subprocess.check_output(
            ["git", "merge-base", "HEAD", f"refs/tags/platform-v{current}"], text=True
        ).strip()
        package["release-as"] = args.version
        package["prerelease"] = version(args.version)[3] is not None
        config_path.write_text(json.dumps(config, indent=2) + "\n")
        print(
            f"Prepared {args.version}. Review and commit the config, then open a PR against {args.branch}."
        )
    else:
        requested = package.get("release-as")
        if not requested:
            raise ValueError(
                "No version requested. Run release-policy.py prepare first"
            )
        validate_request(args.branch, current, requested)
        validate_supported(requested, args.latest)
        anchor = config.get("last-release-sha", "")
        if not re.fullmatch(r"[0-9a-f]{40}", anchor):
            raise ValueError("Missing changelog anchor; use release-policy.py prepare")
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", anchor, "HEAD"], check=True
        )
        if (
            package["prerelease"] != (version(requested)[3] is not None)
            or not package["draft"]
        ):
            raise ValueError(
                "Release config must use drafts and match the version's prerelease status"
            )
        print(f"requested={requested}")
        print(f"create_pr={'true' if current != requested else 'false'}")


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error)) from error
