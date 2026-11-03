"""Cancel only active merge-group runs whose queue ref no longer has their SHA.

Runs from the default branch with no checkout/artifact from the observed runs.
API errors leave jobs running. Recheck identity and the ref before each cancel.
"""

from datetime import datetime, timedelta, timezone
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

QUEUE_REF = re.compile(r"^gh-readonly-queue/.+/pr-[0-9]+-[0-9a-f]{40}$")
ACTIVE = {"queued", "in_progress", "waiting", "pending", "requested"}


class API:
    def __init__(self):
        self.root = os.environ["GITHUB_API_URL"] + "/repos/" + os.environ["GITHUB_REPOSITORY"]

    def request(self, path, method="GET"):
        request = urllib.request.Request(
            self.root + path, method=method,
            headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                     "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            return json.loads(body) if body else None

    def ref_sha(self, branch):
        try:
            return self.request("/git/ref/heads/" + urllib.parse.quote(branch, safe="/"))["object"]["sha"]
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise


def eligible(run, cutoff):
    return (run.get("event") == "merge_group" and run.get("status") in ACTIVE
            and bool(QUEUE_REF.fullmatch(run.get("head_branch") or ""))
            and bool(re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha") or ""))
            and run.get("created_at", "~") < cutoff)


def cancel_obsolete(api, run, cutoff, dry_run):
    if not eligible(run, cutoff) or api.ref_sha(run["head_branch"]) == run["head_sha"]:
        return False
    # A rerun can reuse a run ID. Do not cancel a different attempt or identity.
    current = api.request(f'/actions/runs/{run["id"]}')
    if not eligible(current, cutoff) or any(current.get(key) != run.get(key) for key in (
        "head_sha", "head_branch", "run_attempt",
    )):
        return False
    if api.ref_sha(run["head_branch"]) == run["head_sha"]:
        return False
    print(f'{"Would cancel" if dry_run else "Cancelling"} obsolete queue run {run["id"]} ({run["head_sha"]})')
    if not dry_run:
        api.request(f'/actions/runs/{run["id"]}/cancel', "POST")
    return True


def main():
    api = API()
    observer = api.request("/actions/runs/" + os.environ["GITHUB_RUN_ID"])
    repo = api.request("")
    # Verify contents access before treating a queue ref's 404 as absence.
    if api.ref_sha(repo["default_branch"]) is None:
        raise RuntimeError("Cannot verify repository refs; leaving all jobs running")
    # Allow newly created queue refs to become visible before interpreting 404s.
    cutoff = (datetime.fromisoformat(observer["created_at"].replace("Z", "+00:00"))
              - timedelta(minutes=2)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    runs = {}
    for status in sorted(ACTIVE):
        for page in range(1, 11):
            batch = api.request(f"/actions/runs?event=merge_group&status={status}&per_page=100&page={page}")["workflow_runs"]
            runs.update((run["id"], run) for run in batch)
            if len(batch) < 100:
                break
    count = 0
    for run in runs.values():
        try:
            count += cancel_obsolete(api, run, cutoff, os.environ.get("DRY_RUN") == "true")
        except (urllib.error.URLError, KeyError, ValueError) as error:
            print(f'Leaving run {run["id"]} running: {type(error).__name__}')
    print(f"Obsolete runs identified: {count}")


if __name__ == "__main__":
    main()
