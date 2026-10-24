#!/usr/bin/env python3
"""Verify and relay scanned queue artifacts; never rebuild a release fallback."""

import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlencode
import zipfile


SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
WORKFLOW = ".github/workflows/docker-image-scanning.yml"
MAX_AGE = dt.timedelta(hours=24)
MAX_ARCHIVE = 20 * 1024**3


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def api(path):
    return json.loads(command("gh", "api", path))


def pages(path, key, request=api):
    result = []
    for page in range(1, 101):
        rows = request(f"{path}{'&' if '?' in path else '?'}per_page=100&page={page}")[key]
        result.extend(rows)
        if len(rows) < 100:
            return result
    raise ValueError("Incomplete GitHub pagination")


def digest(path):
    with path.open("rb") as source:
        return "sha256:" + hashlib.file_digest(source, "sha256").hexdigest()


def fresh(value, now):
    created = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt.timedelta(0) <= now - created <= MAX_AGE


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inventory(sha):
    """Read the release's inventory without checking out or executing its code."""
    files = ["platform/shared/agent-catalog-images.json", "platform/Dockerfile",
             *[f"platform/docker_images/{name}/Dockerfile" for name in ("agent", "mcp_server", "p4_shim", "sandbox_base")]]
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for name in files:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(command("git", "show", f"{sha}:{name}"))
        return load_module("release-image-policy").candidate_matrix(root)


def archive_metadata(artifacts, name, now):
    matches = [row for row in artifacts if row["name"] == name]
    if len(matches) != 1:
        raise ValueError(f"Missing or duplicate artifact: {name}")
    artifact = matches[0]
    if (artifact["expired"] or not fresh(artifact["created_at"], now)
            or not DIGEST.fullmatch(artifact.get("digest") or "")
            or artifact.get("size_in_bytes", 0) > MAX_ARCHIVE):
        raise ValueError(f"Expired or unbound artifact: {name}")
    return artifact


def download(repository, artifact, destination):
    # Only the existing release-please job uses its existing App token here.
    # The token is never put in outputs, artifacts, reusable jobs, or URLs.
    with destination.open("wb") as output:
        subprocess.run(["gh", "api", f"repos/{repository}/actions/artifacts/{int(artifact['id'])}/zip"],
                       stdout=output, check=True)
    if digest(destination) != artifact["digest"]:
        raise ValueError("GitHub artifact archive checksum mismatch")


def unpack(archive, destination, names, limit=MAX_ARCHIVE):
    with zipfile.ZipFile(archive) as files:
        rows = files.infolist()
        if (len(rows) != len(names) or {row.filename for row in rows} != set(names)
                or sum(row.file_size for row in rows) > limit
                or any(row.filename.endswith(".json") and row.file_size > 1024**2 for row in rows)
                or any(row.is_dir() or (row.external_attr >> 16) & 0o170000 == 0o120000 for row in rows)):
            raise ValueError("Unexpected candidate archive contents")
        destination.mkdir(parents=True, exist_ok=True)
        for name in names:
            with files.open(name) as source, (destination / name).open("wb") as output:
                shutil.copyfileobj(source, output)


def validate_index(index, run, repository, branch, tree, version, matrix, now):
    expected = {(row["image"], arch) for row in matrix["include"] for arch in ("amd64", "arm64")}
    if (index.get("schema") != 1 or index.get("fixture") or index.get("repository") != repository
            or index.get("branch") != branch or index.get("source_tree") != tree
            or index.get("source_sha") != run["head_sha"] or index.get("run_id") != str(run["id"])
            or index.get("run_attempt") != str(run["run_attempt"]) or not fresh(index["created_at"], now)):
        raise ValueError("Candidate index is not bound to the selected queue run and release tree")
    actual = set()
    candidate = load_module("release-candidate")
    for record in index["records"]:
        pair = (record["image"], record["arch"])
        if pair not in expected or pair in actual or record.get("scan_result") != "success" or record.get("version") != version:
            raise ValueError("Incomplete or unsuccessful candidate scan inventory")
        candidate.verify_record(record, {key: index[key] for key in (
            "repository", "source_sha", "source_tree", "run_id", "run_attempt")}, now)
        previous = record.get("previous_image", "")
        if previous and not re.fullmatch(r"docker.io/archestra/platform@sha256:[0-9a-f]{64}", previous):
            raise ValueError("Candidate previous assets are not immutable")
        actual.add(pair)
    if actual != expected:
        raise ValueError("Incomplete candidate scan inventory")


def select(repository, branch, release_sha, version, matrix, request=api, fetch=download, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    if not SHA.fullmatch(release_sha):
        raise ValueError("A complete release SHA is required")
    release = request(f"repos/{repository}/git/commits/{release_sha}")
    tree = release["tree"]["sha"]
    if not SHA.fullmatch(tree):
        raise ValueError("Missing release tree")
    prefix = f"gh-readonly-queue/{branch}/"
    query = urlencode({"event": "merge_group", "created": ">=" + (now - MAX_AGE).isoformat()})
    runs = pages(f"repos/{repository}/actions/workflows/docker-image-scanning.yml/runs?{query}", "workflow_runs", request)
    matching = []
    for run in runs:
        if (run.get("path") != WORKFLOW or run.get("event") != "merge_group"
                or not run["head_branch"].startswith(prefix) or not SHA.fullmatch(run["head_sha"])
                or run["repository"]["full_name"] != repository
                or run["head_repository"]["full_name"] != repository or not fresh(run["created_at"], now)):
            continue
        commit = request(f"repos/{repository}/git/commits/{run['head_sha']}")
        if commit["tree"]["sha"] == tree:
            matching.append(run)
    if not matching:
        raise ValueError("No fresh scanned merge-group tree matches this release; refusing to rebuild")
    # Never substitute an older success for a failed/newer run of the same tree.
    run = max(matching, key=lambda value: (value["created_at"], value["id"]))
    if run["status"] != "completed" or run["conclusion"] != "success":
        raise ValueError("Latest matching queue scan has not succeeded")
    jobs = pages(f"repos/{repository}/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs", "jobs", request)
    gates = [job for job in jobs if job["name"] == "Release Image Security"]
    scans = [job for job in jobs if job["name"].startswith("Scan release candidate (")]
    if (len(gates) != 1 or gates[0]["status"] != "completed" or gates[0]["conclusion"] != "success"
            or len(scans) != len(matrix["include"]) * 2
            or any(job["status"] != "completed" or job["conclusion"] != "success" for job in scans)):
        raise ValueError("Queue gate or required native scan legs did not succeed")
    artifacts = pages(f"repos/{repository}/actions/runs/{run['id']}/artifacts", "artifacts", request)
    meta = archive_metadata(artifacts, f"release-candidate-index-{run['run_attempt']}", now)
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        archive = directory / "index.zip"
        fetch(repository, meta, archive)
        unpack(archive, directory, ["release-candidate-index.json"], 1024**2)
        index = json.loads((directory / "release-candidate-index.json").read_text())
    validate_index(index, run, repository, branch, tree, version, matrix, now)
    for record in index["records"]:
        name = f"release-candidate-{record['image']}-{record['arch']}-{run['run_attempt']}"
        record["artifact"] = archive_metadata(artifacts, name, now)
    return {"schema": 1, "repository": repository, "release_sha": release_sha,
            "release_tree": tree, "version": version, "index": index}


def selected_record(selection, image, arch):
    rows = [row for row in selection["index"]["records"] if row["image"] == image and row["arch"] == arch]
    if len(rows) != 1:
        raise ValueError("Missing selected image/architecture")
    return rows[0]


def relay(selection, image, arch, directory, fetch=download):
    record = selected_record(selection, image, arch)
    load_module("release-candidate").verify_record(record, {key: selection["index"][key] for key in (
        "repository", "source_sha", "source_tree", "run_id", "run_attempt")})
    archive = directory.with_suffix(".zip")
    try:
        fetch(selection["repository"], record["artifact"], archive)
        unpack(archive, directory, ["build.json", "image.tar"])
        build = json.loads((directory / "build.json").read_text())
        expected = {key: value for key, value in record.items() if key not in ("scan_result", "artifact")}
        if build != expected or digest(directory / "image.tar") != record["archive_digest"]:
            raise ValueError("Candidate bytes/metadata differ from the successful scan")
    finally:
        archive.unlink(missing_ok=True)


def verify_loaded(selection, image, arch, directory):
    if (selection.get("schema") != 1 or selection["repository"] != os.environ["GITHUB_REPOSITORY"]
            or command("git", "rev-parse", "HEAD") != selection["release_sha"]
            or command("git", "rev-parse", "HEAD^{tree}") != selection["release_tree"]
            or selection["version"] != os.environ["EXPECTED_VERSION"]):
        raise ValueError("Relayed candidates do not match this release checkout")
    record = selected_record(selection, image, arch)
    build = json.loads((directory / "build.json").read_text())
    if build != {key: value for key, value in record.items() if key not in ("scan_result", "artifact")}:
        raise ValueError("Relayed candidate metadata changed")
    if digest(directory / "image.tar") != record["archive_digest"]:
        raise ValueError("Relayed candidate bytes changed")
    candidate = load_module("release-candidate")
    candidate.verify_record(record, {key: selection["index"][key] for key in (
        "repository", "source_sha", "source_tree", "run_id", "run_attempt")})
    if record.get("scan_result") != "success" or selection["index"].get("fixture"):
        raise ValueError("Relayed candidate is not successful production scan evidence")
    if any(record.get(key) != value for key, value in candidate.build_inputs(image, arch).items()):
        raise ValueError("Release build inputs changed after scanning")
    subprocess.run(["docker", "load", "--input", str(directory / "image.tar")], check=True)
    candidate.inspect_image(record["image_id"], record["image_id"], arch)
    return record


def push(record, image, arch):
    if not re.fullmatch(r"(?:docker.io/archestra|europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public)/[a-z0-9-]+", image):
        raise ValueError("Unexpected release image destination")
    suffix = f"{int(os.environ['GITHUB_RUN_ID'])}-{int(os.environ['GITHUB_RUN_ATTEMPT'])}-{arch}"
    incoming = f"{image}:candidate-{suffix}"
    subprocess.run(["docker", "tag", record["image_id"], incoming], check=True)
    subprocess.run(["docker", "push", incoming], check=True)
    refs = json.loads(command("docker", "image", "inspect", incoming, "--format", "{{json .RepoDigests}}"))
    # Docker normalizes Docker Hub repository names by omitting docker.io/.
    if image.startswith("docker.io/"):
        refs = ["docker.io/" + ref if ref.startswith(image.removeprefix("docker.io/") + "@") else ref for ref in refs]
    refs = sorted({ref for ref in refs if re.fullmatch(re.escape(image) + r"@sha256:[0-9a-f]{64}", ref)})
    if len(refs) != 1:
        raise ValueError("Cannot bind pushed image to exactly one registry digest")
    manifest = json.loads(command("docker", "buildx", "imagetools", "inspect", refs[0], "--raw"))
    if manifest["config"]["digest"] != record["image_id"]:
        raise ValueError("Registry image config differs from the scanned image")
    # Preserve the existing single-platform-index publication scan interface.
    index_tag = f"{image}:candidate-index-{suffix}"
    subprocess.run(["docker", "buildx", "imagetools", "create", "--prefer-index=true", "--tag", index_tag, refs[0]], check=True)
    result = json.loads(command("docker", "buildx", "imagetools", "inspect", index_tag, "--format", "{{json .Manifest}}"))["digest"]
    if not DIGEST.fullmatch(result):
        raise ValueError("Missing promoted architecture index digest")
    return result


def main():
    mode = sys.argv[1]
    selected = Path(os.environ["SELECTION_FILE"])
    if mode == "select":
        sha = os.environ["RELEASE_SHA"]
        manifest = json.loads(command("git", "show", f"{sha}:.github/release-please/.release-please-manifest.json"))
        if manifest["platform"] != os.environ["EXPECTED_VERSION"]:
            raise ValueError("Release version does not match its source manifest")
        value = select(os.environ["GITHUB_REPOSITORY"], os.environ["RELEASE_BRANCH"], sha,
                       manifest["platform"], inventory(sha))
        selected.parent.mkdir(parents=True, exist_ok=True)
        selected.write_text(json.dumps(value))
    else:
        selection = json.loads(selected.read_text())
        image, arch = os.environ["IMAGE_NAME"], os.environ["IMAGE_ARCH"]
        directory = Path(os.environ["CANDIDATE_DIR"])
        if mode == "relay":
            relay(selection, image, arch, directory)
        elif mode == "promote":
            record = verify_loaded(selection, image, arch, directory)
            result = push(record, os.environ["IMAGE_DESTINATION"], arch)
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"digest={result}\n")
        else:
            raise ValueError("Unknown handoff operation")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        sys.exit(f"Release image handoff failed: {error}")
