#!/usr/bin/env python3
"""Open reviewed backport PRs for merged default-branch fixes; never merge them."""

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlencode


class ManualBackportRequired(Exception):
    pass


class Backporter:
    def __init__(self, repo, checkout, targets):
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise ValueError("Invalid repository name")
        if not targets or any(not re.fullmatch(r"release/\d+\.\d+", target) for target in targets):
            raise ValueError("Backport targets must be explicit release/X.Y branches")
        self.repo = repo
        self.checkout = Path(checkout)
        self.targets = set(targets)

    def poll(self):
        # Scan the durable label requests, including old PRs after an outage.
        # Fetch existing backports once per target to avoid reprocessing them.
        for target in sorted(self.targets):
            query = urlencode({"state": "all", "base": target, "per_page": 100})
            existing = self.api(f"repos/{self.repo}/pulls?{query}", paginate=True)
            heads = {pr["head"]["ref"] for pr in existing
                     if (pr["head"].get("repo") or {}).get("full_name") == self.repo}
            query = urlencode({"state": "closed", "labels": f"backport {target}", "per_page": 100})
            requests = self.api(f"repos/{self.repo}/issues?{query}", paginate=True)
            for issue in requests:
                if "pull_request" not in issue:
                    continue
                branch = f"backport/{target.replace('/', '-')}/pr-{issue['number']}"
                if branch in heads:
                    continue
                try:
                    self.run(issue["number"], target)
                except ValueError as error:
                    print(f"Ignoring ineligible PR #{issue['number']}: {error}")

    def run(self, number, target_override=""):
        pr = self.api(f"repos/{self.repo}/pulls/{number}")
        default = self.api(f"repos/{self.repo}")["default_branch"]
        if not pr["merged"] or pr["base"]["ref"] != default:
            raise ValueError("Only merged default-branch PRs can be backported")
        sha = pr["merge_commit_sha"]
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise ValueError("Invalid merge commit SHA")
        requested = {label["name"].removeprefix("backport ") for label in pr["labels"]
                     if label["name"].startswith("backport ")}
        if target_override:
            requested = {target_override}
        if not requested:
            print("No backport labels found.")
            return
        self.git("fetch", "origin", f"+refs/heads/{default}:refs/remotes/origin/{default}")
        self.git("merge-base", "--is-ancestor", sha, f"origin/{default}")
        parents = self.git("show", "-s", "--format=%P", sha).stdout.split()
        if not parents:
            raise ValueError("Cannot backport a root commit")
        files = self.git("diff", "--name-only", parents[0], sha).stdout.splitlines()
        for target in sorted(requested):
            if not re.fullmatch(r"release/\d+\.\d+", target):
                raise ValueError("Backport labels must use backport release/X.Y")
            if target not in self.targets:
                self.report(number, target, "This branch is not enabled in .github/backport-targets.json. No backport was created.")
                continue
            try:
                if has_schema_changes(files):
                    raise ManualBackportRequired("This PR changes database schemas or migrations. Stable fixes exclude schema migrations; prepare a separately reviewed fix without those changes.")
                self.backport(pr, target, sha, len(parents) > 1)
            except ManualBackportRequired as error:
                self.report(number, target, str(error))

    def backport(self, pr, target, sha, is_merge):
        number = pr["number"]
        branch = f"backport/{target.replace('/', '-')}/pr-{number}"
        query = urlencode({"state": "all", "head": f"{self.repo.split('/')[0]}:{branch}", "base": target})
        existing = self.api(f"repos/{self.repo}/pulls?{query}")
        if existing:
            print(f"Backport already exists: {existing[0]['html_url']} ({existing[0]['state']})")
            return
        self.git("fetch", "origin", f"+refs/heads/{target}:refs/remotes/origin/{target}")
        remote = self.git("ls-remote", "--exit-code", "--heads", "origin", f"refs/heads/{branch}", check=False)
        if remote.returncode == 0:
            # Recover a push that succeeded before PR creation failed. Never
            # replace a branch or discard edits made by a reviewer.
            self.git("fetch", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}")
            message = self.git("show", "-s", "--format=%B", f"origin/{branch}").stdout
            if f"(cherry picked from commit {sha})" not in message:
                raise ManualBackportRequired(f"Branch `{branch}` already exists without the expected source commit. Inspect it manually; it was not modified.")
        elif remote.returncode == 2:
            self.create_branch(target=target, branch=branch, sha=sha, is_merge=is_merge)
        else:
            raise RuntimeError("Cannot inspect the remote backport branch")
        suffix = f" (backport {target})"
        title = " ".join(pr["title"].split())[:100 - len(suffix)] + suffix
        body = (f"Backports #{number} to `{target}` using `git cherry-pick -x`.\n\n"
                f"Source commit: `{sha}`.\n\n"
                "Review this branch's diff and CI results before adding it to the merge queue. "
                "Stable publication still requires the existing release approval.\n")
        result = self.api(f"repos/{self.repo}/pulls", {"title": title, "head": branch, "base": target, "body": body})
        self.report(number, target, f"Opened {result['html_url']} for review. This automation does not merge or approve releases.")
        print(result["html_url"])

    def create_branch(self, *, target, branch, sha, is_merge):
        with tempfile.TemporaryDirectory(prefix="archestra-backport-") as directory:
            worktree = Path(directory) / "checkout"
            self.git("worktree", "add", "--detach", str(worktree), f"origin/{target}")
            try:
                args = ["cherry-pick", "-x"] + (["-m", "1"] if is_merge else []) + [sha]
                result = self.git(*args, cwd=worktree, check=False)
                if result.returncode:
                    conflicts = self.git("ls-files", "--unmerged", cwd=worktree).stdout
                    empty = self.git("diff", "--quiet", "HEAD", cwd=worktree, check=False).returncode == 0
                    if not conflicts and empty:
                        raise ManualBackportRequired("The change is already present on this branch. No duplicate backport PR was created.")
                    raise ManualBackportRequired("The cherry-pick conflicts with this release branch. Resolve it manually with `git cherry-pick -x`; no branch was pushed.")
                self.git("push", "origin", f"HEAD:refs/heads/{branch}", cwd=worktree)
            finally:
                self.git("worktree", "remove", "--force", str(worktree))

    def report(self, number, target, message):
        marker = f"<!-- archestra-backport:{number}:{target} -->"
        body = f"{marker}\nBackport to `{target}`: {message}"
        comments = self.api(f"repos/{self.repo}/issues/{number}/comments", paginate=True)
        for comment in comments:
            if comment.get("user", {}).get("type") == "Bot" and comment["body"].startswith(marker):
                if comment["body"] != body:
                    self.api(f"repos/{self.repo}/issues/comments/{comment['id']}", {"body": body}, method="PATCH")
                return
        self.api(f"repos/{self.repo}/issues/{number}/comments", {"body": body})

    def api(self, endpoint, payload=None, *, method=None, paginate=False):
        args = ["gh", "api", endpoint]
        if method:
            args += ["--method", method]
        if payload is not None:
            args += ["--input", "-"]
        if paginate:
            args += ["--paginate", "--slurp"]
        result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                                text=True, capture_output=True, check=True)
        data = json.loads(result.stdout)
        return [item for page in data for item in page] if paginate else data

    def git(self, *args, cwd=None, check=True):
        # No credentials are written to the checkout or included in argv.
        command = ["git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
                   "-c", 'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
                   "-c", "user.name=Archestra backport automation",
                   "-c", "user.email=backport-bot@users.noreply.github.com", *args]
        return subprocess.run(command, cwd=cwd or self.checkout, text=True, capture_output=True,
                              check=check, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})


def has_schema_changes(files):
    return any(name.startswith("platform/backend/src/database/schemas/") or
               (name.startswith("platform/backend/src/database/migrations/") and
                (name.endswith(".sql") or "/meta/" in name)) for name in files)


def main():
    root = Path(__file__).resolve().parents[2]
    targets = json.loads((root / ".github/backport-targets.json").read_text())["branches"]
    bot = Backporter(os.environ["GH_REPO"], root, targets)
    source = os.environ.get("SOURCE_PR", "")
    if source:
        number = int(source)
        if number <= 0:
            raise ValueError("PR number must be positive")
        bot.run(number, os.environ.get("TARGET_BRANCH", ""))
    else:
        bot.poll()



if __name__ == "__main__":
    main()
