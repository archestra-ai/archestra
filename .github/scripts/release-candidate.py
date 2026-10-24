#!/usr/bin/env python3
"""Bind both native builds and every successful scan to this workflow attempt.

Archives are retained after scans; they are not publication credentials
or permission to replace the independent release-publication scans.
"""

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
PLATFORM = "docker.io/archestra/platform"


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def build_inputs(image, arch):
    if arch not in ("amd64", "arm64"):
        raise ValueError("Unsupported release architecture")
    version = json.loads(Path(".github/release-please/.release-please-manifest.json").read_text())["platform"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[1-9][0-9]*)?", version):
        raise ValueError("Invalid release version")
    previous = ""
    if image in ("platform", "platform-slim"):
        # Use the same predecessor as publication, including a synthetic queue
        # commit containing a release PR plus ordinary PRs.
        tags = command("git", "tag", "--merged", "HEAD^", "--list", "platform-v*")
        if tags:
            tag = command("git", "describe", "--tags", "--abbrev=0", "--match", "platform-v*", "HEAD^")
            if tag == f"platform-v{version}":
                raise ValueError("Candidate version is already a release ancestor")
            reference = f"{PLATFORM}:{tag.removeprefix('platform-v')}"
            index = json.loads(command("docker", "buildx", "imagetools", "inspect", reference, "--raw"))
            matches = [row["digest"] for row in index["manifests"]
                       if row.get("platform", {}).get("os") == "linux"
                       and row.get("platform", {}).get("architecture") == arch]
            if len(matches) != 1 or not DIGEST.fullmatch(matches[0]):
                raise ValueError("Previous release must resolve to exactly one immutable architecture")
            previous = f"{PLATFORM}@{matches[0]}"
    return {"version": version, "previous_image": previous}


def file_digest(path):
    with path.open("rb") as source:
        return "sha256:" + hashlib.file_digest(source, "sha256").hexdigest()


def identity():
    sha = command("git", "rev-parse", "HEAD")
    tree = command("git", "rev-parse", "HEAD^{tree}")
    if sha != os.environ["GITHUB_SHA"] or not SHA.fullmatch(tree):
        raise ValueError("Checkout does not match the scanned workflow revision")
    return {"source_sha": sha, "source_tree": tree, "run_id": os.environ["GITHUB_RUN_ID"],
            "run_attempt": os.environ["GITHUB_RUN_ATTEMPT"], "repository": os.environ["GITHUB_REPOSITORY"]}


def inspect_image(reference, image_id, arch):
    data = json.loads(command("docker", "image", "inspect", reference))[0]
    if (not DIGEST.fullmatch(image_id) or data["Id"] != image_id
            or data["Os"] != "linux" or data["Architecture"] != arch):
        raise ValueError("Loaded bytes do not match the built image or architecture")


def verify_record(record, expected, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    if record.get("schema") != 1 or any(record.get(key) != value for key, value in expected.items()):
        raise ValueError("Stale or mismatched candidate evidence")
    created = dt.datetime.fromisoformat(record["created_at"])
    if not dt.timedelta(0) <= now - created <= dt.timedelta(hours=24):
        raise ValueError("Candidate evidence expired or is from the future")
    for key in ("image_id", "archive_digest"):
        if not DIGEST.fullmatch(record.get(key, "")):
            raise ValueError("Candidate evidence requires immutable byte identities")


def validate_evidence(directory, matrix):
    expected_identity = identity()
    expected = {(row["image"], arch) for row in matrix["include"] for arch in ("amd64", "arm64")}
    actual = set()
    for path in directory.iterdir():
        if not path.is_file() or path.is_symlink() or path.suffix != ".json":
            raise ValueError("Unexpected candidate evidence file")
        record = json.loads(path.read_text())
        pair = (record["image"], record["arch"])
        if pair not in expected or pair in actual or record.get("scan_result") != "success":
            raise ValueError("Every image/architecture must have exactly one successful scan")
        verify_record(record, expected_identity)
        inputs = build_inputs(*pair)
        if any(record.get(key) != value for key, value in inputs.items()):
            raise ValueError("Scan used different release build inputs")
        actual.add(pair)
    if actual != expected:
        raise ValueError(f"Incomplete scan inventory: missing {sorted(expected - actual)}")
    return [json.loads(path.read_text()) for path in sorted(directory.iterdir())]


def main():
    mode = sys.argv[1]
    image, arch = os.environ["IMAGE_NAME"], os.environ["IMAGE_ARCH"]
    directory = Path(os.environ["CANDIDATE_DIR"])
    if mode == "inputs":
        inputs = build_inputs(image, arch)
        if inputs["version"] != os.environ["EXPECTED_VERSION"]:
            raise ValueError("Publication version differs from the source manifest")
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"version={inputs['version']}\nprevious-image={inputs['previous_image']}\n")
    elif mode == "prepare":
        directory.mkdir(parents=True, exist_ok=True)
        record = {"schema": 1, "image": image, "arch": arch, **identity(), **build_inputs(image, arch),
                  "created_at": dt.datetime.now(dt.timezone.utc).isoformat()}
        (directory / "build.json").write_text(json.dumps(record))
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"version={record['version']}\nprevious-image={record['previous_image']}\n")
    elif mode == "seal":
        record = json.loads((directory / "build.json").read_text())
        image_id = command("docker", "image", "inspect", os.environ["IMAGE_REFERENCE"], "--format", "{{.Id}}")
        inspect_image(os.environ["IMAGE_REFERENCE"], image_id, arch)
        record.update(image_id=image_id, archive_digest=file_digest(directory / "image.tar"))
        (directory / "build.json").write_text(json.dumps(record))
    elif mode in ("verify", "scanned"):
        record = json.loads((directory / "build.json").read_text())
        verify_record(record, {**identity(), "image": image, "arch": arch})
        if record["archive_digest"] != file_digest(directory / "image.tar"):
            raise ValueError("Candidate archive changed in transit")
        inspect_image(record["image_id"], record["image_id"], arch)
        if mode == "verify":
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"reference=local://{record['image_id']}\n")
        else:
            if os.environ["SCAN_OUTCOME"] != "success":
                raise ValueError("Scan did not succeed")
            record["scan_result"] = "success"
            evidence = directory / "evidence"
            evidence.mkdir()
            (evidence / f"{image}-{arch}.json").write_text(json.dumps(record))
    else:
        raise ValueError("Unknown candidate mode")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"Release candidate validation failed: {error}")
