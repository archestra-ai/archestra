#!/usr/bin/env python3
"""Decide when a push may recover a draft release, and record the holds that
stop it.

A Release Please run hands its request to release-publisher and ends
(publish-release-images, `wait: false`); release-finalize.yml publishes the
GitHub release once the publisher run succeeds (archestra-ai/.github
release-finalize.yml finds and checks the request). A later push on the same
line may recover a draft release that never got there. These modes decide
whether it may:

  recovery-hold
           GH_REPO, GITHUB_REF_NAME, PUBLISHER_REPOSITORY, PUBLISHER_TOKEN,
           VERSION, RELEASE_SHA, DRAFT_CREATED_AT, RETRY_HELD
           (GH_TOKEN: this repository, actions read)
           Prints why a push must not recover VERSION's draft release, or
           nothing. release-please.yml recovers a draft only when this prints
           nothing; see recovery_hold.
  record-hold
           GH_REPO, GITHUB_REF_NAME, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, VERSION,
           RELEASE_SHA, HOLD_DIR, GITHUB_OUTPUT (GH_TOKEN: actions read)
           When a release scan of this run found vulnerabilities, writes
           HOLD_DIR/held.json and outputs the artifact `name` to keep it
           under, which holds the draft from later recoveries.
"""

import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys

VERSION = re.compile(r"\d+\.\d+\.\d+(?:-rc\.\d+)?")
RELEASE_WORKFLOW = ".github/workflows/release-please.yml"
REQUESTER = "archestra-releaser[bot]"
PUBLISH_TITLE = re.compile(r"Publish archestra (\S+) \[([1-9][0-9]*-[1-9][0-9]*)\]")
SHA = re.compile(r"[0-9a-f]{40}")
# release-handoff.py's MAX_AGE: a recovery selects only queue scans this fresh.
EVIDENCE_AGE = dt.timedelta(hours=24)


def command(*args, token=None):
    environment = None if token is None else {**os.environ, "GH_TOKEN": token}
    return subprocess.check_output(args, text=True, env=environment).strip()


def api(path, token=None):
    return json.loads(command("gh", "api", path, token=token))


def held_artifact(version, release_sha):
    """The artifact a Release Please run keeps when the current scan rejects
    the exact bytes it promoted for `version` at `release_sha`."""
    return f"release-held-{version}-{release_sha}"


def recovery_hold(repository, branch, version, release_sha, draft_created_at, publisher, publisher_token,
                  retry_held=False, request=api, now=None, warn=print):
    """(kind, reason) when a push to `branch` must not recover the draft
    release of `version` (at `release_sha`), or None. kind is "open",
    "published", "expired" or "rejected"; the last two hold the draft.

    A recovery hands the draft off again from the exact bytes the merge queue
    scanned for its release commit; it never rebuilds them. So it does not run
    when it is redundant or cannot succeed:

    - the publisher already has a request for the version that has not
      finished (waiting for its approval, say), or one that succeeded: the
      images are public and release-finalize.yml publishes the GitHub release;
    - the queue scan evidence has expired: the draft is older than
      EVIDENCE_AGE, so every queue scan of its commit is too;
    - a release run already found vulnerabilities in those exact bytes (a CVE
      published after the queue scanned them) and no request has been sent
      since: every recovery would promote and scan the same bytes again.
      RETRY_HELD scans them once more, after an advisory is withdrawn or
      reclassified, say.

    An unreadable publisher only warns: the other checks still apply.
    """
    if not VERSION.fullmatch(version) or not SHA.fullmatch(release_sha):
        raise ValueError("A release version and full release SHA are required")
    now = now or dt.datetime.now(dt.timezone.utc)
    tag = f"platform-v{version}"
    requests = []
    try:
        runs = request(f"repos/{publisher}/actions/workflows/publish.yml/runs"
                       "?event=repository_dispatch&branch=main&per_page=100", token=publisher_token)["workflow_runs"]
        for run in runs:
            title = PUBLISH_TITLE.fullmatch(run.get("display_title") or "")
            if title and title.group(1) == version and (run.get("triggering_actor") or {}).get("login") == REQUESTER:
                requests.append((run, title.group(2)))
    except (KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        warn(f"::warning::Could not read release-publisher's runs ({error}); checking {tag} without them")
    for run, request_id in requests:
        if run.get("status") != "completed":
            url = run.get("html_url") or f"run {run.get('id')}"
            return "open", f"Draft release {tag} already has an open publish request ({url}); not requesting it again"
    for run, request_id in requests:
        if run.get("conclusion") == "success":
            url = run.get("html_url") or f"run {run.get('id')}"
            return "published", (
                f"Publish request {request_id} for {tag} already succeeded ({url}); release-finalize.yml publishes "
                f"the GitHub release (dispatch it with request_id={request_id} if the draft remains)")

    created = dt.datetime.fromisoformat(draft_created_at.replace("Z", "+00:00"))
    if now - created > EVIDENCE_AGE:
        return "expired", (
            f"Draft release {tag} is older than the {EVIDENCE_AGE.total_seconds() / 3600:g}-hour queue scan "
            "evidence a recovery may promote, and a recovery never rebuilds; not recovering it")

    if retry_held:
        return None
    newest_request = max((run["created_at"] for run, _ in requests), default="")
    name = held_artifact(version, release_sha)
    artifacts = request(f"repos/{repository}/actions/artifacts?name={name}&per_page=100")["artifacts"]
    for artifact in sorted(artifacts, key=lambda row: row["created_at"], reverse=True):
        source = artifact.get("workflow_run") or {}
        # A later request means a later hand-off passed the scan.
        if (artifact.get("name") != name or artifact.get("expired") or source.get("head_branch") != branch
                or artifact["created_at"] < newest_request):
            continue
        run = request(f"repos/{repository}/actions/runs/{int(source['id'])}")
        if (run.get("path") == RELEASE_WORKFLOW and run.get("head_branch") == branch
                and run.get("event") in ("push", "workflow_dispatch")
                and run["repository"]["full_name"] == repository):
            url = run.get("html_url") or f"run {run['id']}"
            return "rejected", (
                f"Release run {url} found vulnerabilities in the exact scanned bytes of {tag}, which a "
                "recovery promotes again and never rebuilds; not recovering it")
    return None


def record_hold(repository, run_id, attempt, version, release_sha, request=api):
    """The hold to keep for this release run's attempt, or None: the images
    whose release scan found vulnerabilities in their exact promoted bytes
    (build-native-multi-arch-image.yml keeps a
    release-scan-findings-<image>-<arch> artifact for each architecture it
    scans). Any other failure leaves later pushes to recover."""
    if not VERSION.fullmatch(version) or not SHA.fullmatch(release_sha):
        raise ValueError("A release version and full release SHA are required")
    findings = re.compile(rf"release-scan-findings-([a-z0-9][a-z0-9-]*?)(?:-(?:amd64|arm64))?-{attempt}")
    images = set()
    for page in range(1, 11):
        rows = request(f"repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100&page={page}")["artifacts"]
        images |= {match.group(1) for row in rows if (match := findings.fullmatch(row["name"]))}
        if len(rows) < 100:
            break
    if not images:
        return None
    return {"version": version, "release_sha": release_sha, "run_id": run_id, "run_attempt": attempt,
            "images": sorted(images)}


def held_summary(repository, tag, branch, reason):
    """The job summary for a held draft: what happened and the ways out."""
    return f"""### Draft release {tag} is held

{reason}.

Pushes to `{branch}` no longer recover it. A recovery only promotes the bytes
the merge queue scanned for this release commit; it never rebuilds a version.
Choose one (see platform/dev/RELEASE.md, Troubleshooting):

- **Abandon the version** (usual): delete the draft release and keep its tag,
  `gh release delete {tag} --repo {repository} --yes`. The next
  release PR on `{branch}` (with the fix) then proceeds under a new version.
- **Scan the same bytes again**, when a finding no longer applies (a withdrawn
  or reclassified advisory) and the queue scan is under 24 hours old:
  `gh workflow run release-please.yml --repo {repository} --ref {branch} -f retry-held-release=true`.
- **Request a handed-off release again** without rebuilding: re-run only the
  **Publish release images and chart** job of its Release Please run.
"""


def main():
    mode = sys.argv[1]
    environment = os.environ
    repository = environment["GH_REPO"]
    if mode == "recovery-hold":
        version = environment["VERSION"]
        hold = recovery_hold(repository, environment["GITHUB_REF_NAME"], version, environment["RELEASE_SHA"],
                             environment["DRAFT_CREATED_AT"], environment["PUBLISHER_REPOSITORY"],
                             environment["PUBLISHER_TOKEN"], environment.get("RETRY_HELD") == "true",
                             warn=lambda line: print(line, file=sys.stderr))
        kind, reason = hold or ("", "")
        if kind in ("expired", "rejected") and environment.get("GITHUB_STEP_SUMMARY"):
            with open(environment["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write(held_summary(repository, f"platform-v{version}", environment["GITHUB_REF_NAME"], reason))
        print(reason)
    elif mode == "record-hold":
        version, branch = environment["VERSION"], environment["GITHUB_REF_NAME"]
        run_id, attempt = int(environment["GITHUB_RUN_ID"]), int(environment["GITHUB_RUN_ATTEMPT"])
        hold = record_hold(repository, run_id, attempt, version, environment["RELEASE_SHA"])
        if hold is None:
            print("No release scan found vulnerabilities; later pushes may recover the draft")
            return
        directory = Path(environment["HOLD_DIR"])
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "held.json").write_text(json.dumps(hold, indent=2) + "\n")
        with open(environment["GITHUB_OUTPUT"], "a") as output:
            output.write(f"name={held_artifact(version, hold['release_sha'])}\n")
        reason = (f"This run found vulnerabilities in the exact scanned bytes of {', '.join(hold['images'])}, "
                  "which a recovery promotes again and never rebuilds")
        print(f"::notice::{reason}; later pushes do not recover platform-v{version}")
        if environment.get("GITHUB_STEP_SUMMARY"):
            with open(environment["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write(held_summary(repository, f"platform-v{version}", branch, reason))
    else:
        raise ValueError(f"Unknown mode {mode}")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, json.JSONDecodeError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"::error::{error}")
