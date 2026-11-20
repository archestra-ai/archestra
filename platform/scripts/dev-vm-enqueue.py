#!/usr/bin/env python3
"""pnpm enqueue (scripts/enqueue.mjs) for the dev VM setup: runs on the Mac
without Node or pnpm.

The preflight needs the dependencies, so it runs in the VM through
dev-vm-sync.py run, on this checkout's VM copy. Everything that talks to
GitHub runs here with your gh login, which never enters the VM. The guards
are enqueue.mjs's: a clean, unchanged checkout of the exact PR head, an open
and ready PR, a target branch that requires the merge queue, and a queue-only
request for that revision.

Usage, from inside the checkout:
  platform/scripts/dev-vm-enqueue.py <PR-number> [--repo [HOST/]OWNER/REPO]
"""
import json
import os
import re
import subprocess
import sys
from urllib.parse import quote, urlparse

PLATFORM = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
USAGE = "Usage: platform/scripts/dev-vm-enqueue.py <PR-number> [--repo [HOST/]OWNER/REPO]"


class Refused(Exception):
    pass


def main(argv):
    if argv == ["--help"]:
        print(USAGE)
        return
    number, option, repository = (argv + [None, None, None])[:3]
    extra = argv[3:]
    if (not re.fullmatch(r"[1-9][0-9]*", number or "", re.ASCII) or int(number) > 2 ** 53 - 1
            or (option is not None and (option != "--repo" or not repository)) or extra):
        raise Refused(USAGE)
    target = dict(number=int(number), **resolve_repository(repository))
    head = git("rev-parse", "HEAD")
    assert_revision(head)
    pr = read_pull_request(target)
    assert_pull_request(pr, head)
    require_merge_queue(target, pr["baseRefName"])

    print("Checking %s at %s before queue entry, in the dev VM." % (pr["url"], head), flush=True)
    preflight = subprocess.run([os.path.join(PLATFORM, "scripts", "dev-vm-sync.py"), "run",
                                "pnpm preflight %s" % head], cwd=PLATFORM)  # pnpm puts node_modules/.bin on PATH
    if preflight.returncode != 0:
        raise Refused("Preflight failed in the dev VM; nothing was queued.")

    refreshed = read_pull_request(target)
    assert_pull_request(refreshed, head)
    if refreshed["baseRefName"] != pr["baseRefName"]:
        raise Refused("The PR target branch changed during preflight. Inspect it before retrying.")
    # Refresh the target branch policy after the potentially long preflight.
    require_merge_queue(target, refreshed["baseRefName"])
    assert_revision(head)
    # Queue-only: a concurrent rule change must never turn this into a direct merge.
    graphql(target, """mutation($id:ID!, $head:GitObjectID!) {
      enqueuePullRequest(input:{pullRequestId:$id, expectedHeadOid:$head}) {
        mergeQueueEntry { id }
      }
    }""", {"id": refreshed["id"], "head": head})

    response = graphql(target, """query($owner:String!, $name:String!, $number:Int!) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        state headRefOid
        mergeQueueEntry { position }
      }
    }
  }""", {"owner": target["owner"], "name": target["name"], "number": target["number"]})
    queued = ((response or {}).get("repository") or {}).get("pullRequest")
    if not queued or queued.get("headRefOid") != head:
        raise Refused("Could not confirm queue entry for the checked revision. Inspect %s before retrying." % pr["url"])
    if queued.get("state") == "MERGED":
        print("Merged %s at checked PR revision %s." % (pr["url"], head))
    elif queued.get("mergeQueueEntry"):
        print("Queued %s at %s (position %s). Monitor CI until merged."
              % (pr["url"], head, queued["mergeQueueEntry"].get("position")))
    else:
        raise Refused("GitHub has not confirmed queue entry. Inspect %s before retrying." % pr["url"])


def resolve_repository(explicit):
    if explicit:
        parts = explicit.split("/")
        if len(parts) == 2:
            parts.insert(0, "github.com")
    else:
        remote = git("remote", "get-url", "origin")
        url = urlparse(re.sub(r"^git@([^:]+):", r"ssh://git@\1/", remote))
        if url.scheme not in ("https", "ssh") or not url.hostname:
            raise Refused("Cannot resolve origin as a GitHub repository. Pass --repo [HOST/]OWNER/REPO.")
        parts = [url.hostname] + re.sub(r"\.git$", "", url.path.lstrip("/")).split("/")
    if (len(parts) != 3 or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", parts[0])
            or not all(re.fullmatch(r"[\w.-]+", p, re.ASCII) and p not in (".", "..") for p in parts[1:])):
        raise Refused("Invalid repository. Use --repo [HOST/]OWNER/REPO.")
    host, owner, name = parts
    return {"host": host, "owner": owner, "name": name, "selector": "/".join(parts)}


def read_pull_request(target):
    pr = json.loads(run("gh", "pr", "view", str(target["number"]), "--repo", target["selector"],
                        "--json", "id,number,url,state,isDraft,headRefOid,baseRefName,mergeable"))
    if pr.get("number") != target["number"] or not pr.get("id"):
        raise Refused("GitHub did not return the requested PR identity.")
    return pr


def graphql(target, query, variables):
    args = ["api", "graphql", "--hostname", target["host"], "-f", "query=" + query]
    for key, value in variables.items():
        args += ["-F" if isinstance(value, int) else "-f", "%s=%s" % (key, value)]
    return json.loads(run("gh", *args)).get("data")


def assert_pull_request(pr, head):
    if pr.get("state") != "OPEN" or pr.get("isDraft") or pr.get("mergeable") == "CONFLICTING":
        raise Refused("The PR must be open, ready for review, and free of merge conflicts before enqueueing.")
    if pr.get("headRefOid") != head:
        raise Refused("Local HEAD does not match the current PR head. Check out the exact revision before enqueueing.")


def require_merge_queue(target, base):
    rules = json.loads(run("gh", "api", "--hostname", target["host"],
                           "repos/%s/%s/rules/branches/%s" % (target["owner"], target["name"], quote(base, safe=""))))
    if not isinstance(rules, list) or not any(isinstance(r, dict) and r.get("type") == "merge_queue" for r in rules):
        raise Refused("The target branch %s does not require a merge queue; refusing to enqueue." % base)


def assert_revision(head):
    if git("rev-parse", "HEAD") != head or git("status", "--porcelain", "--untracked-files=normal"):
        raise Refused("Enqueue requires a clean, unchanged checkout of the checked PR head.")


def git(*args):
    return run("git", *args)


def run(command, *args):
    try:
        done = subprocess.run([command, *args], cwd=PLATFORM, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True)
    except OSError as error:
        raise Refused(str(error))
    if done.returncode != 0:
        raise Refused(done.stderr.strip() or "%s failed; queue entry was not confirmed." % command)
    return done.stdout.strip()


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (Refused, ValueError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
