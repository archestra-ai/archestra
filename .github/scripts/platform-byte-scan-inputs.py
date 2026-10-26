#!/usr/bin/env python3
"""Retain and select an available E2E image pair without requiring green tests."""

import datetime as dt
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile


IMAGE = "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/platform"
ARTIFACT = "platform-byte-scan-inputs"
FILENAME = f"{ARTIFACT}.json"
MAX_AGE = dt.timedelta(days=7)
SHA = re.compile(r"[0-9a-f]{40}")
REFERENCE = re.compile(re.escape(IMAGE) + r"@sha256:[0-9a-f]{64}")
RESOLVER = Path(__file__).with_name("resolve-attested-image.sh")


def api(path, binary=False):
    data = subprocess.check_output(["gh", "api", path])
    return data if binary else json.loads(data)


def resolve(reference):
    pinned = subprocess.check_output(["bash", str(RESOLVER), reference], text=True).strip()
    if not REFERENCE.fullmatch(pinned):
        raise ValueError("Image resolver did not return an immutable Platform reference")
    if "@" in reference and pinned != reference:
        raise ValueError("Retained Platform image digest changed")
    return pinned


def record(sha, resolve_image=resolve):
    if not SHA.fullmatch(sha):
        raise ValueError("A complete E2E source SHA is required")
    return {"schema": 1, "source_sha": sha, "platform": "linux/amd64",
            "full": resolve_image(f"{IMAGE}:{sha}-e2e"),
            "slim": resolve_image(f"{IMAGE}:{sha}-e2e-slim")}


def validate_record(value, sha):
    if (value.get("schema") != 1 or value.get("source_sha") != sha
            or not SHA.fullmatch(sha) or value.get("platform") != "linux/amd64"):
        raise ValueError("Retained image record does not match its E2E build")
    if not all(REFERENCE.fullmatch(value.get(key, "")) for key in ("full", "slim")):
        raise ValueError("Retained image record must contain both immutable Platform digests")
    if value["full"] == value["slim"]:
        raise ValueError("Full and slim image digests must be distinct")
    return value


def select(repository, branch, request=api, resolve_image=resolve, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    listing = request(f"repos/{repository}/actions/artifacts?name={ARTIFACT}&per_page=100")
    artifacts = sorted(listing["artifacts"], key=lambda item: item["created_at"], reverse=True)
    for artifact in artifacts:
        created = dt.datetime.fromisoformat(artifact["created_at"].replace("Z", "+00:00"))
        build = artifact.get("workflow_run", {})
        if (artifact["name"] != ARTIFACT or artifact["expired"]
                or not dt.timedelta(0) <= now - created <= MAX_AGE
                or build.get("head_branch") != branch):
            continue
        run = request(f"repos/{repository}/actions/runs/{int(build['id'])}")
        started = dt.datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        # Failed/running browser tests do not invalidate a completed image build.
        # Exclude PR/queue/fork artifacts and other workflows, even with the same name.
        if (run["path"] != ".github/workflows/platform-e2e-tests.yml"
                or run["event"] not in ("schedule", "workflow_dispatch")
                or run["head_branch"] != branch or run["head_sha"] != build["head_sha"]
                or not dt.timedelta(0) <= now - started <= MAX_AGE
                or run["repository"]["full_name"] != repository):
            continue
        archive = request(f"repos/{repository}/actions/artifacts/{int(artifact['id'])}/zip", binary=True)
        with zipfile.ZipFile(io.BytesIO(archive)) as files:
            if files.namelist() != [FILENAME] or files.getinfo(FILENAME).file_size > 16384:
                raise ValueError("Invalid retained image record archive")
            value = validate_record(json.loads(files.read(FILENAME)), run["head_sha"])
        try:
            # Registry cleanup can remove bytes before metadata expires. Never scan
            # floating replacements; try the next fresh, complete retained pair.
            resolve_image(value["full"])
            resolve_image(value["slim"])
        except subprocess.CalledProcessError:
            print(f"E2E run {run['id']} no longer has both images; trying another retained pair.", file=sys.stderr)
            continue
        print(f"Selected E2E run {run['id']} ({value['source_sha']})", file=sys.stderr)
        return value | {"run_id": run["id"]}
    raise ValueError(f"No available full/slim E2E image pair retained for {branch} in the last 7 days")


def main():
    if sys.argv[1] == "record":
        value = validate_record(record(os.environ["GITHUB_SHA"]), os.environ["GITHUB_SHA"])
        destination = Path(os.environ["RUNNER_TEMP"]) / FILENAME
        destination.write_text(json.dumps(value) + "\n")
    elif sys.argv[1] == "select":
        sha = os.environ.get("INPUT_IMAGE_SHA", "")
        value = (validate_record(record(sha), sha) if sha else
                 select(os.environ["REPOSITORY"], os.environ["SOURCE_BRANCH"]))
        # Write outputs only after the complete pair is validated and available.
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for key in ("source_sha", "full", "slim"):
                output.write(f"{key}={value[key]}\n")
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(f"Platform byte scan source: {value['source_sha']}\n\n"
                          f"Full: `{value['full']}`\n\nSlim: `{value['slim']}`\n")
    else:
        raise ValueError("Expected record or select")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        sys.exit(f"Platform byte scan input selection failed: {error}")
