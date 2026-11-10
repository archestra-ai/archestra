#!/usr/bin/env python3
"""Hold a release-please PR until the release before it on its line is published.

A merged release PR leaves a DRAFT GitHub release (tag platform-vX.Y.Z) that
waits for its approval in release-publisher; release-finalize.yml un-drafts it
once the publisher run succeeds. Merging the next release PR on the same line
meanwhile would stack a second release behind the first. This check fails a
release PR (base main: X.Y.0-rc.N; base release/X.Y: X.Y.Z) while a release
on its line that is older than its version, and newer than the line's newest
published release, is still a draft. It passes every other PR.

Only push access lists draft releases, so the check's token needs contents
write (as release-finalize.yml's sweep does). A draft that was deleted to
abandon a version (its tag is kept) holds nothing back, nor does a draft older
than a release published after it.

  check    pull_request: PR_NUMBER. merge_group: MERGE_GROUP_BASE_SHA,
           MERGE_GROUP_HEAD_SHA, MERGE_GROUP_HEAD_REF. Both: GH_REPO,
           GITHUB_STEP_SUMMARY.
           (GH_TOKEN: contents write to list drafts, pull-requests write, actions read)
  recheck  GH_REPO, WORKFLOW_FILE: re-runs this check on each open release PR
           whose last run failed and that is now clear.
           (GH_TOKEN: contents write to list drafts, pull-requests read, actions write)
"""

import json
import os
import re
import subprocess
import sys

TAG_PREFIX = "platform-v"
VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?")
RELEASE_HEAD = "release-please--branches--"
RELEASE_TITLE = re.compile(r"chore\((?P<base>[^)\s]+)\): release platform (?P<version>\S+)")
RELEASE_WORKFLOW = "release-please.yml"
COMMENT_MARKER = "<!-- previous-release-published -->"
COMMENT_AUTHOR = "github-actions[bot]"
# release-publisher is private: this repository's token cannot read its runs,
# so the comment links the waiting ones instead of naming each.
PUBLISHER_WAITING_URL = ("https://github.com/archestra-ai/release-publisher/actions/workflows/publish.yml"
                         "?query=status%3Awaiting")
MERGE_GROUP_PR = re.compile(r"/pr-(\d+)-[0-9a-f]+$")
SQUASH_PR = re.compile(r"\(#(\d+)\)$")


# =============================================================================
# Release lines
# =============================================================================


def version_key(version):
    """Sort key for X.Y.Z and X.Y.Z-rc.N; a release candidate sorts before its release."""
    match = VERSION.fullmatch(version or "")
    if not match:
        raise ValueError(f"Not a platform version: {version!r}")
    major, minor, patch, rc = match.groups()
    return (int(major), int(minor), int(patch), 0 if rc is not None else 1, int(rc or 0))


def release_line(version):
    """main releases X.Y.0-rc.N; release/X.Y releases X.Y.Z."""
    version_key(version)
    major, minor, _ = version.split("-")[0].split(".")
    return "main" if "-rc." in version else f"release/{major}.{minor}"


def release_target(pull):
    """(base branch, version) a release-please PR releases, or None for any other PR."""
    if not (pull.get("head") or {}).get("ref", "").startswith(RELEASE_HEAD):
        return None
    base = pull["base"]["ref"]
    title = RELEASE_TITLE.fullmatch((pull.get("title") or "").strip())
    if not title:
        raise ValueError(f"Release PR #{pull['number']} title is not 'chore(<base>): release platform X.Y.Z'")
    version = title.group("version")
    if title.group("base") != base or release_line(version) != base:
        raise ValueError(f"Release PR #{pull['number']} releases {version}, which is not on {base}")
    return base, version


def drafts_before(version, releases):
    """Draft releases on `version`'s line older than it and newer than the
    line's newest published release, newest first. `releases` are
    (tag, draft) pairs."""
    line, key = release_line(version), version_key(version)
    earlier = []
    for tag, draft in releases:
        candidate = tag.removeprefix(TAG_PREFIX)
        if tag.startswith(TAG_PREFIX) and VERSION.fullmatch(candidate) and release_line(candidate) == line \
                and version_key(candidate) < key:
            earlier.append((version_key(candidate), candidate, draft))
    newest_published = max((item[0] for item in earlier if not item[2]), default=None)
    return [candidate for candidate_key, candidate, draft in sorted(earlier, reverse=True)
            if draft and (newest_published is None or candidate_key > newest_published)]


# =============================================================================
# GitHub
# =============================================================================


class GitHub:
    """The few REST calls this check makes, through `gh api`."""

    def __init__(self, repository):
        self.repository = repository

    def get(self, path):
        return json.loads(self._gh("api", path))

    def get_optional(self, path):
        try:
            return self.get(path)
        except subprocess.CalledProcessError as error:
            if "HTTP 404" in (error.stderr or ""):
                return None
            raise

    def lines(self, path, jq):
        return [line for line in self._gh("api", "--paginate", path, "--jq", jq).splitlines() if line]

    def send(self, method, path, body=None):
        output = self._gh("api", "--method", method, path, "--input", "-", stdin=json.dumps(body or {}))
        return json.loads(output) if output else {}

    def _gh(self, *args, stdin=None):
        return subprocess.run(("gh", *args), input=stdin, text=True, capture_output=True, check=True).stdout.strip()


def blockers_for(github, version):
    """The draft releases holding `version` back, each with its Release Please run."""
    repository = github.repository
    releases = [tuple(json.loads(line)) for line in
                github.lines(f"repos/{repository}/releases?per_page=100", ".[] | [.tag_name, .draft] | @json")]
    found = []
    for blocked in drafts_before(version, releases):
        tag = f"{TAG_PREFIX}{blocked}"
        ref = github.get_optional(f"repos/{repository}/git/ref/tags/{tag}")
        run_url = None
        if ref and ref["object"]["type"] == "commit":
            runs = github.get(f"repos/{repository}/actions/workflows/{RELEASE_WORKFLOW}/runs"
                              f"?head_sha={ref['object']['sha']}&event=push&per_page=1")["workflow_runs"]
            run_url = runs[0]["html_url"] if runs else None
        found.append({"version": blocked, "tag": tag, "run_url": run_url})
    return found


def merge_group_pulls(github, base_sha, head_sha, head_ref):
    """The PRs a merge group merges: the one its ref names, and every squashed
    commit's "(#N)" between its base and head."""
    numbers = []
    named = MERGE_GROUP_PR.search(head_ref or "")
    if named:
        numbers.append(int(named.group(1)))
    comparison = github.get(f"repos/{github.repository}/compare/{base_sha}...{head_sha}")
    for commit in comparison.get("commits", []):
        subject = commit["commit"]["message"].splitlines()[0].strip() if commit["commit"]["message"] else ""
        squashed = SQUASH_PR.search(subject)
        if squashed and int(squashed.group(1)) not in numbers:
            numbers.append(int(squashed.group(1)))
    return [github.get(f"repos/{github.repository}/pulls/{number}") for number in numbers]


def update_comment(github, number, body, blocked):
    """Keep one comment on the PR: post it when blocked, rewrite it when the
    state changes, and post nothing for a PR that was never blocked."""
    comments = github.lines(f"repos/{github.repository}/issues/{number}/comments?per_page=100",
                            f'.[] | select(.user.login == "{COMMENT_AUTHOR}" and (.body | contains("{COMMENT_MARKER}")))'
                            " | {id, body} | @json")
    existing = json.loads(comments[0]) if comments else None
    if existing is None:
        if blocked:
            github.send("POST", f"repos/{github.repository}/issues/{number}/comments", {"body": body})
            return "posted"
        return "none"
    if existing["body"].strip() == body.strip():
        return "unchanged"
    github.send("PATCH", f"repos/{github.repository}/issues/comments/{existing['id']}", {"body": body})
    return "updated"


# =============================================================================
# Messages
# =============================================================================


def render(base, version, blockers):
    if not blockers:
        return (f"{COMMENT_MARKER}\n### ✅ Unblocked: the previous release is published\n\n"
                f"Every earlier release on `{base}` is published, so {version} can be merged.\n")
    rows = "\n".join(
        f"- **{blocker['version']}** (`{blocker['tag']}`) is still a draft"
        + (f": [Release Please run]({blocker['run_url']})" if blocker["run_url"] else "")
        for blocker in blockers)
    return (f"{COMMENT_MARKER}\n### ⏸️ Waiting for the previous release on `{base}`\n\n"
            f"This PR releases **{version}**, but an earlier release on the same line is not published yet:\n\n"
            f"{rows}\n\n"
            "A release is published after its release-publisher run is approved in the `stable-release` "
            f"environment ([waiting publisher runs]({PUBLISHER_WAITING_URL})). Get it approved there; to "
            "abandon that version instead, delete its draft release and keep its tag "
            "(`platform/dev/RELEASE.md`). This check re-runs on its own once the release is published.\n")


# =============================================================================
# Modes
# =============================================================================


def check(github, environment):
    """Evaluate every release PR the event covers; True when all are clear."""
    if environment.get("PR_NUMBER"):
        pulls = [github.get(f"repos/{github.repository}/pulls/{environment['PR_NUMBER']}")]
        comment = True
    else:
        pulls = merge_group_pulls(github, environment["MERGE_GROUP_BASE_SHA"], environment["MERGE_GROUP_HEAD_SHA"],
                                  environment.get("MERGE_GROUP_HEAD_REF", ""))
        comment = False
    clear, summary = True, []
    for pull in pulls:
        target = release_target(pull)
        if target is None:
            continue
        base, version = target
        blockers = blockers_for(github, version)
        body = render(base, version, blockers)
        summary.append(body.replace(COMMENT_MARKER + "\n", "", 1))
        clear = clear and not blockers
        if blockers:
            print(f"::error::#{pull['number']} ({version}) waits for "
                  + ", ".join(blocker["version"] for blocker in blockers) + " to be published")
        if comment:
            try:
                print(f"Comment: {update_comment(github, pull['number'], body, bool(blockers))}")
            except subprocess.CalledProcessError as error:
                print(f"::warning::Could not update the PR comment: {error.stderr or error}")
    if not summary:
        summary.append("Not a release PR: nothing to wait for.\n")
    if environment.get("GITHUB_STEP_SUMMARY"):
        with open(environment["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write("\n".join(summary))
    print("\n".join(summary))
    return clear


def recheck(github, environment):
    """Re-run the failed check of each open release PR that is now clear, so
    its required check turns green on the PR's head commit."""
    repository, workflow = github.repository, environment["WORKFLOW_FILE"]
    rerun = []
    for line in github.lines(f"repos/{repository}/pulls?state=open&per_page=100",
                             f'.[] | select(.head.ref | startswith("{RELEASE_HEAD}")) | @json'):
        pull = json.loads(line)
        target = release_target(pull)
        if target is None:
            continue
        runs = github.get(f"repos/{repository}/actions/workflows/{workflow}/runs"
                          f"?head_sha={pull['head']['sha']}&per_page=20")["workflow_runs"]
        runs = [run for run in runs if run["event"] == "pull_request"]
        if not runs or runs[0]["status"] != "completed" or runs[0]["conclusion"] != "failure":
            continue
        if blockers_for(github, target[1]):
            print(f"#{pull['number']} ({target[1]}) is still waiting")
            continue
        print(f"#{pull['number']} ({target[1]}) is clear: re-running {runs[0]['html_url']}")
        github.send("POST", f"repos/{repository}/actions/runs/{runs[0]['id']}/rerun-failed-jobs")
        rerun.append(pull["number"])
    return rerun


def main():
    mode = sys.argv[1]
    github = GitHub(os.environ["GH_REPO"])
    if mode == "check":
        if not check(github, os.environ):
            sys.exit(1)
    elif mode == "recheck":
        recheck(github, os.environ)
    else:
        raise ValueError(f"Unknown mode {mode}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(f"::error::{' '.join(error.cmd)} failed: {error.stderr}")
    except (KeyError, ValueError, json.JSONDecodeError, OSError) as error:
        sys.exit(f"::error::{error}")
