#!/usr/bin/env python3
"""Find the handed-off release requests that release-finalize.yml finishes.

A Release Please run hands its request to release-publisher and ends
(publish-release-images, `wait: false`); the release waits for its approval
in the publisher. release-finalize.yml then publishes the GitHub release once
the publisher run has succeeded. Two ways start it:

- Release Gate dispatches it on the release branch with `request_id`
  (`<run>-<attempt>`) when the publisher run for that request succeeds.
- A schedule sweeps (on main) for draft releases whose publisher run has
  succeeded, and dispatches it on each request's branch, in case Release
  Gate missed one.

Neither is trusted. `request` reads everything from this repository's own
release run and its `release-request-<attempt>` artifact; the finalize job
then checks the publisher run and the public names (release-publish-verify)
before it writes anything.

  request  REQUEST_ID, GH_REPO, GITHUB_REF_NAME, REQUEST_DIR, GITHUB_OUTPUT
           (GH_TOKEN: this repository, actions read and push access)
  sweep    GH_REPO, PUBLISHER_REPOSITORY, PUBLISHER_TOKEN, GITHUB_OUTPUT
           (GH_TOKEN: this repository, push access and actions write)
  open-request
           GH_REPO, PUBLISHER_REPOSITORY, PUBLISHER_TOKEN, VERSION
           Prints the publisher run of an open (not yet finished) request for
           VERSION, or nothing. release-please.yml recovers a draft release
           only when it has none, so a push to the branch while the release
           waits for its approval does not request it again.
"""

import json
import os
from pathlib import Path
import re
import subprocess
import sys

REQUEST_ID = re.compile(r"([1-9][0-9]*)-([1-9][0-9]*)")
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-rc\.\d+)?")
RELEASE_WORKFLOW = ".github/workflows/release-please.yml"
RELEASE_BRANCH = re.compile(r"main|release/\d+\.\d+")
REQUESTER = "archestra-releaser[bot]"
PROJECT = "archestra"
PUBLISH_TITLE = re.compile(r"Publish archestra (\S+) \[([1-9][0-9]*-[1-9][0-9]*)\]")


def command(*args, token=None):
    environment = None if token is None else {**os.environ, "GH_TOKEN": token}
    return subprocess.check_output(args, text=True, env=environment).strip()


def api(path, token=None):
    return json.loads(command("gh", "api", path, token=token))


def download(repository, run_id, name, directory):
    command("gh", "run", "download", str(run_id), "--repo", repository, "--name", name, "--dir", str(directory))


def resolve(repository, branch, request_id, directory, request=api, fetch=download):
    """The handed-off request `request_id` of this repository's release run on
    `branch`, and whether its draft release still needs publishing."""
    match = REQUEST_ID.fullmatch(request_id or "")
    if not match:
        raise ValueError("request_id must be <run id>-<run attempt>")
    if not RELEASE_BRANCH.fullmatch(branch):
        raise ValueError(f"Releases finish only on main or release/X.Y, not {branch}")
    run_id, attempt = int(match.group(1)), int(match.group(2))
    run = request(f"repos/{repository}/actions/runs/{run_id}")
    if (run.get("path") != RELEASE_WORKFLOW or run.get("head_branch") != branch
            or run.get("event") not in ("push", "workflow_dispatch")
            or run["repository"]["full_name"] != repository or run.get("run_attempt", 0) < attempt):
        raise ValueError(f"Run {run_id} is not a {RELEASE_WORKFLOW} run on {branch}")
    fetch(repository, run_id, f"release-request-{attempt}", directory)
    payload = json.loads((Path(directory) / "request.json").read_text())
    version = payload.get("version", "")
    if (payload.get("project") != PROJECT or payload.get("request_id") != request_id
            or not VERSION.fullmatch(version) or payload.get("smoke")):
        raise ValueError(f"The kept request of run {run_id} attempt {attempt} is not an archestra release")
    tag = f"platform-v{version}"
    drafts = {release["tag_name"]: release for release in request(f"repos/{repository}/releases?per_page=100")}
    release = drafts.get(tag)
    if release is None:
        raise ValueError(f"No release {tag}")
    return {"run_id": run_id, "attempt": attempt, "version": version, "tag_name": tag,
            "publish": bool(release.get("draft")), "request_file": str(Path(directory) / "request.json")}


def sweep(repository, publisher, publisher_token, request=api):
    """(branch, request id) for each draft release whose newest publisher run
    succeeded, newest request first."""
    drafts = {release["tag_name"].removeprefix("platform-v") for release in
              request(f"repos/{repository}/releases?per_page=100")
              if release.get("draft") and re.fullmatch(r"platform-v" + VERSION.pattern, release["tag_name"])}
    if not drafts:
        return []
    runs = request(f"repos/{publisher}/actions/workflows/publish.yml/runs"
                   "?event=repository_dispatch&branch=main&per_page=100", token=publisher_token)["workflow_runs"]
    newest = {}
    for run in runs:
        title = PUBLISH_TITLE.fullmatch(run.get("display_title") or "")
        if not title or title.group(1) not in drafts or (run.get("triggering_actor") or {}).get("login") != REQUESTER:
            continue
        # The newest request for a version decides: an older success must not
        # finish a version whose latest request was rejected or failed.
        if title.group(1) not in newest or run["created_at"] > newest[title.group(1)]["created_at"]:
            newest[title.group(1)] = run
    found = []
    for version, run in sorted(newest.items()):
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            continue
        request_id = PUBLISH_TITLE.fullmatch(run["display_title"]).group(2)
        source = request(f"repos/{repository}/actions/runs/{request_id.split('-')[0]}")
        if source.get("path") == RELEASE_WORKFLOW and RELEASE_BRANCH.fullmatch(source.get("head_branch") or ""):
            found.append((source["head_branch"], request_id))
    return found


def open_request(publisher, version, publisher_token, request=api):
    """The URL of a publisher run for `version` that the release App
    requested and that has not finished (queued, waiting for its approval,
    pending behind it in the version's concurrency group, or publishing), or
    None."""
    runs = request(f"repos/{publisher}/actions/workflows/publish.yml/runs"
                   "?event=repository_dispatch&branch=main&per_page=100", token=publisher_token)["workflow_runs"]
    for run in runs:
        title = PUBLISH_TITLE.fullmatch(run.get("display_title") or "")
        if (title and title.group(1) == version and run.get("status") != "completed"
                and (run.get("triggering_actor") or {}).get("login") == REQUESTER):
            return run.get("html_url") or f"run {run.get('id')}"
    return None


def main():
    mode = sys.argv[1]
    environment = os.environ
    repository = environment["GH_REPO"]
    if mode == "request":
        result = resolve(repository, environment["GITHUB_REF_NAME"], environment["REQUEST_ID"],
                         environment["REQUEST_DIR"])
        with open(environment["GITHUB_OUTPUT"], "a") as output:
            for key, value in result.items():
                output.write(f"{key}={str(value).lower() if isinstance(value, bool) else value}\n")
        print(f"Request {environment['REQUEST_ID']}: {result['tag_name']}"
              + ("" if result["publish"] else " is already published"))
    elif mode == "sweep":
        for branch, request_id in sweep(repository, environment["PUBLISHER_REPOSITORY"],
                                        environment["PUBLISHER_TOKEN"]):
            print(f"Finishing request {request_id} on {branch}")
            command("gh", "workflow", "run", "release-finalize.yml", "--repo", repository, "--ref", branch,
                    "-f", f"request_id={request_id}")
    elif mode == "open-request":
        version = environment["VERSION"]
        if not VERSION.fullmatch(version):
            raise ValueError(f"Not a release version: {version}")
        print(open_request(environment["PUBLISHER_REPOSITORY"], version, environment["PUBLISHER_TOKEN"]) or "")
    else:
        raise ValueError(f"Unknown mode {mode}")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, json.JSONDecodeError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"::error::{error}")
