#!/usr/bin/env python3
"""Cut a new stable release line from a published release candidate.

A repository admin runs the cut, because only admins create release/* branches
(the infra repository's "release/* creation restricted" ruleset), with `gh`
authenticated:

  stable-line.py plan   --rc-tag platform-v1.5.0-rc.44   # read-only
  stable-line.py cut    --rc-tag platform-v1.5.0-rc.44
  stable-line.py handoff --line 1.5                      # before merging 1.5.0

`plan` reads the repository and prints what `cut` would do and what blocks it.
`cut` checks the same plan, then creates release/X.Y at the release candidate's
commit, opens the release/X.Y pull request that configures Release Please for
X.Y.0, and opens the main pull request that starts X.(Y+1).0-rc.1. Both pull
requests merge on their own once checks pass and a reviewer approves them.
Running `cut` again resumes: it keeps what already exists and stops on anything
that is not what it would have made.

`handoff` checks the previous line has nothing in flight and that every fix it
got after the cut is on the new line. The previous line may stay open; once the
infra repository makes it read-only, `handoff` also closes its open pull
requests. Rulesets belong to Terraform in the infra repository; `plan` and
`handoff` print the change to make there when one is missing.

Release Finalize runs two more commands after a release publishes:

  stable-line.py stable-notes    --tag platform-vX.Y.0   # before publishing X.Y.0
  stable-line.py clear-release-as --branch B --version V  # after publishing V

The repository comes from GH_REPO (default archestra-ai/archestra).
"""

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, urlencode

CONFIG_PATH = ".github/release-please/release-please-config.json"
MANIFEST_PATH = ".github/release-please/.release-please-manifest.json"
DEPENDABOT_PATH = ".github/dependabot.yml"
TARGETS_PATH = ".github/backport-targets.json"
RELEASE_LINE_PATH = "platform/release-line.json"
INFRA_LINES = "archestra-ai/infra github/org/archestra-release-lines.json"
NOTES_MARKER = "<!-- stable-line-notes -->"
# GitHub refuses a longer release body.
RELEASE_BODY_LIMIT = 125_000
RC_TAG = re.compile(r"platform-v(\d+)\.(\d+)\.0-rc\.(\d+)")
STABLE_TAG = re.compile(r"platform-v(\d+)\.(\d+)\.(\d+)")
LINE = re.compile(r"(\d+)\.(\d+)")
# Check-run conclusions that satisfy a required check.
PASSING = {"success", "neutral", "skipped"}
# Ruleset fields GitHub returns but does not accept on update.
RULESET_READ_ONLY = {"id", "node_id", "source", "source_type", "_links", "created_at", "updated_at", "current_user_can_bypass"}
# Release Please workflow runs that still need the previous line.
ACTIVE_RUN_STATUSES = ("queued", "in_progress", "waiting", "requested", "pending")


class GitHubError(Exception):
    def __init__(self, endpoint, message):
        super().__init__(f"{endpoint}: {message}")
        match = re.search(r"\(HTTP (\d{3})\)", message)
        self.status = int(match[1]) if match else None


class CutError(Exception):
    pass


class GitHub:
    """`gh` calls for one repository."""

    def __init__(self, repo):
        self.repo = repo

    def run(self, *args, payload=None):
        result = subprocess.run(
            ["gh", *args],
            input=json.dumps(payload) if payload is not None else None,
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise GitHubError(" ".join(args[:2]), result.stderr.strip())
        return result.stdout

    def api(self, endpoint, payload=None, *, method=None, query=None):
        path = f"repos/{self.repo}/{endpoint}" + (f"?{urlencode(query)}" if query else "")
        args = ["api", path]
        if method:
            args += ["--method", method]
        if payload is not None:
            args += ["--input", "-"]
        output = self.run(*args, payload=payload)
        return json.loads(output) if output.strip() else None

    def get(self, endpoint, query=None):
        """The resource, or None when GitHub answers 404."""
        try:
            return self.api(endpoint, query=query)
        except GitHubError as error:
            if error.status == 404:
                return None
            raise

    def pages(self, endpoint, query=None, key=None):
        """Every item of a paginated list; `key` names the list in an object page."""
        path = f"repos/{self.repo}/{endpoint}?{urlencode({**(query or {}), 'per_page': 100})}"
        pages = json.loads(self.run("api", path, "--paginate", "--slurp"))
        return [item for page in pages for item in (page[key] if key else page)]

    def file(self, path, ref):
        """A file's text at `ref`, or None when it does not exist."""
        try:
            return self.run(
                "api", f"repos/{self.repo}/contents/{quote(path)}?{urlencode({'ref': ref})}",
                "-H", "Accept: application/vnd.github.raw",
            )
        except GitHubError as error:
            if error.status == 404:
                return None
            raise

    def ref_sha(self, ref):
        found = self.get(f"git/ref/{ref}")
        return found["object"]["sha"] if found else None

    def tag_commit(self, tag):
        found = self.get(f"git/ref/tags/{tag}")
        if not found:
            return None
        target = found["object"]
        while target["type"] == "tag":
            target = self.api(f"git/tags/{target['sha']}")["object"]
        return target["sha"]

    def contains(self, ancestor, ref):
        """Whether `ancestor` is reachable from `ref`."""
        status = self.api(f"compare/{ancestor}...{quote(ref, safe='/')}")["status"]
        return status in ("ahead", "identical")

    def open_pull(self, head, base):
        owner = self.repo.split("/")[0]
        pulls = self.api("pulls", query={"state": "open", "head": f"{owner}:{head}", "base": base})
        return pulls[0] if pulls else None

    def commit_files(self, base, head, message, files):
        """Put one commit changing `files` on branch `head`, made from branch `base`.

        An existing `head` is kept when it is exactly that commit, so a rerun
        after an interrupted pull request resumes; anything else stops.
        """
        base_sha = self.ref_sha(f"heads/{base}")
        base_tree = self.api(f"git/commits/{base_sha}")["tree"]["sha"]
        entries = [{"path": path, "mode": "100644", "type": "blob", "content": text} for path, text in files.items()]
        tree = self.api("git/trees", {"base_tree": base_tree, "tree": entries}, method="POST")["sha"]
        existing = self.ref_sha(f"heads/{head}")
        if existing:
            commit = self.api(f"git/commits/{existing}")
            if commit["tree"]["sha"] == tree and [parent["sha"] for parent in commit["parents"]] == [base_sha]:
                return existing
            raise CutError(f"Branch {head} already exists with other changes; finish or delete it, then rerun")
        sha = self.api("git/commits", {"message": message, "tree": tree, "parents": [base_sha]}, method="POST")["sha"]
        self.api("git/refs", {"ref": f"refs/heads/{head}", "sha": sha}, method="POST")
        return sha

    def propose(self, base, head, title, body, files):
        """Open (or keep) the pull request from `head` that commits `files` to `base`, set to auto-merge.

        `title` is also the commit message. An open pull request from `head` is
        reused only when it changes exactly `files`, to exactly their contents:
        anyone with write access can open one from that branch name.
        """
        pull = self.open_pull(head, base)
        if pull is not None:
            changed = {item["filename"] for item in self.pages(f"pulls/{pull['number']}/files")}
            if changed != set(files) or any(self.file(path, pull["head"]["sha"]) != text for path, text in files.items()):
                raise CutError(f"#{pull['number']} from {head} is not the change this command makes; review or close it, then rerun")
        else:
            self.commit_files(base, head, title, files)
            pull = self.api("pulls", {"title": title, "head": head, "base": base, "body": body}, method="POST")
        if not pull.get("auto_merge"):
            self.run("pr", "merge", str(pull["number"]), "--repo", self.repo, "--auto")
        return pull


def parse_line(text):
    match = LINE.fullmatch(text)
    if not match:
        raise CutError(f"{text} is not a release line such as 1.5")
    return int(match[1]), int(match[2])


def line_name(line):
    return f"{line[0]}.{line[1]}"


def dump_json(data):
    return json.dumps(data, indent=2) + "\n"


def stable_config(text, version):
    """Release Please settings that make release/X.Y release `version` (X.Y.0) next."""
    config = json.loads(text)
    platform = config["packages"]["platform"]
    platform["versioning"] = "always-bump-patch"
    platform["prerelease"] = False
    platform.pop("prerelease-type", None)
    platform["release-as"] = version
    if platform.get("draft") is not True:
        raise CutError(f"{CONFIG_PATH} must keep draft: true")
    return dump_json(config)


def release_as_config(text, version):
    """Release Please settings that release `version` next on the same track."""
    config = json.loads(text)
    config["packages"]["platform"]["release-as"] = version
    return dump_json(config)


def without_release_as(text):
    config = json.loads(text)
    del config["packages"]["platform"]["release-as"]
    return dump_json(config)


def release_as(text):
    return json.loads(text)["packages"]["platform"].get("release-as")


def unmet_checks(rule, check_runs, statuses):
    """Contexts of a required_status_checks rule the commit has not passed."""
    unmet = []
    for required in rule["parameters"]["required_status_checks"]:
        context, app = required["context"], required.get("integration_id")
        passed = any(
            run["name"] == context and run["conclusion"] in PASSING and app in (None, run["app"]["id"])
            for run in check_runs
        ) or any(status["context"] == context and status["state"] == "success" for status in statuses)
        if not passed:
            unmet.append(context)
    return unmet


def queue_rule(ruleset):
    return next((rule for rule in ruleset["rules"] if rule["type"] == "merge_queue"), None)


@dataclass
class Plan:
    rc_tag: str
    line: tuple
    previous: tuple
    next_rc: str
    rc_commit: str = ""
    branch_sha: str | None = None
    # Repository rulesets whose required checks the RC commit has not passed:
    # creating the branch needs their do_not_enforce_on_create exemption.
    exemptions: list = field(default_factory=list)
    label_done: bool = False
    config_done: bool = False
    next_rc_done: bool = False
    blockers: list = field(default_factory=list)
    steps: list = field(default_factory=list)
    notes: list = field(default_factory=list)

    @property
    def branch(self):
        return f"release/{line_name(self.line)}"

    @property
    def version(self):
        return f"{line_name(self.line)}.0"

    @property
    def label(self):
        return f"backport {self.branch}"

    @property
    def config_head(self):
        return f"automation/stable-cut-{line_name(self.line)}"

    @property
    def next_rc_head(self):
        return f"automation/release-as-{self.next_rc}"

    def step(self, done, text):
        self.steps.append(("done" if done else "todo", text))

    def print(self):
        print(f"Cut {self.branch} from {self.rc_tag} ({self.rc_commit[:12] or 'unknown commit'})")
        if self.line > self.previous:
            print(f"  {self.version} on {self.branch} after release/{line_name(self.previous)}; main starts {self.next_rc}")
        for state, text in self.steps:
            print(f"  [{'x' if state == 'done' else ' '}] {text}")
        for text in self.notes:
            print(f"  note: {text}")
        for text in self.blockers:
            print(f"  BLOCKED: {text}")


def build_plan(gh, rc_tag):
    match = RC_TAG.fullmatch(rc_tag)
    if not match:
        raise CutError(f"{rc_tag} is not a release candidate tag such as platform-v1.5.0-rc.44")
    line = (int(match[1]), int(match[2]))
    targets = json.loads(gh.file(TARGETS_PATH, "main"))["branches"]
    if len(targets) != 1 or not re.fullmatch(r"release/\d+\.\d+", targets[0]):
        raise CutError(f"{TARGETS_PATH} on main must name exactly one release/X.Y line, not {targets}")
    previous = parse_line(targets[0].removeprefix("release/"))
    plan = Plan(rc_tag, line, previous, f"{line[0]}.{line[1] + 1}.0-rc.1")
    if line == previous:
        plan.blockers.append(f"{plan.branch} is already the supported line")
        return plan
    if line < previous:
        plan.blockers.append(f"{plan.branch} is older than the supported release/{line_name(previous)}")
        return plan

    release = gh.get(f"releases/tags/{rc_tag}")
    if not release or release["draft"] or not release["prerelease"]:
        plan.blockers.append(f"{rc_tag} is not a published prerelease")
    plan.rc_commit = gh.tag_commit(rc_tag) or ""
    if not plan.rc_commit:
        plan.blockers.append(f"tag {rc_tag} does not exist")
        return plan
    if not gh.contains(plan.rc_commit, "main"):
        plan.blockers.append(f"{rc_tag} is not on main")
    # Release Finalize runs the line's own copy of this script after X.Y.0 publishes.
    if gh.file(".github/scripts/stable-line.py", rc_tag) is None:
        plan.blockers.append(f"{rc_tag} predates stable-line.py; cut from a later release candidate")
    if gh.ref_sha(f"tags/platform-v{plan.version}"):
        plan.blockers.append(f"platform-v{plan.version} is already tagged; this line has been cut")
    freeze = gh.get("actions/variables/RELEASE_FREEZE")
    if freeze and freeze["value"] == "true":
        plan.blockers.append("releases are frozen (RELEASE_FREEZE)")

    check_queue(gh, plan)
    check_branch(gh, plan)
    check_label(gh, plan)
    check_config_pull(gh, plan)
    check_next_rc(gh, plan)
    check_upgrade_guide(gh, plan)
    return plan


def check_queue(gh, plan):
    rulesets = [gh.api(f"rulesets/{summary['id']}") for summary in gh.pages("rulesets", {"includes_parents": "false"})]
    main = [r for r in rulesets if queue_rule(r) and "refs/heads/main" in r["conditions"]["ref_name"]["include"]]
    exact = [
        r for r in rulesets
        if queue_rule(r) and r["enforcement"] == "active"
        and r["conditions"]["ref_name"]["include"] == [f"refs/heads/{plan.branch}"]
    ]
    if len(main) != 1:
        raise CutError(f"expected one merge queue ruleset on main, found {len(main)}")
    if not exact:
        plan.blockers.append(
            f"no active merge queue ruleset for {plan.branch}: in {INFRA_LINES} add "
            f'"{line_name(plan.line)}" to mergeQueue, merge, and wait for Terraform apply'
        )
    elif queue_rule(exact[0])["parameters"] != queue_rule(main[0])["parameters"]:
        plan.blockers.append(f"the {plan.branch} merge queue settings differ from main's")
    else:
        plan.step(True, f"{plan.branch} merge queue ruleset is in place")


def check_branch(gh, plan):
    plan.branch_sha = gh.ref_sha(f"heads/{plan.branch}")
    if plan.branch_sha:
        if gh.contains(plan.rc_commit, plan.branch):
            plan.step(True, f"{plan.branch} exists at or after {plan.rc_tag}")
        else:
            plan.blockers.append(f"{plan.branch} exists but does not contain {plan.rc_tag}")
        return
    check_runs = gh.pages(f"commits/{plan.rc_commit}/check-runs", key="check_runs")
    statuses = gh.pages(f"commits/{plan.rc_commit}/statuses")
    for rule in gh.pages(f"rules/branches/{quote(plan.branch, safe='')}"):
        if rule["type"] != "required_status_checks":
            continue
        unmet = unmet_checks(rule, check_runs, statuses)
        source = rule["ruleset_source_type"]
        exempt = rule["parameters"].get("do_not_enforce_on_create", False)
        if source == "Repository" and exempt:
            # Terraform keeps it false: true means an earlier cut did not put it back.
            plan.blockers.append(
                f"ruleset {rule['ruleset_id']} already skips required checks on branch creation; "
                "re-apply the infra Terraform that manages it, then rerun"
            )
        elif unmet and not exempt:
            if source != "Repository":
                plan.blockers.append(f"{plan.rc_tag} has not passed organization-required checks: {', '.join(unmet)}")
            else:
                plan.exemptions.append(rule["ruleset_id"])
                plan.notes.append(
                    f"{plan.rc_tag} has not passed {', '.join(unmet)}: cut skips ruleset "
                    f"{rule['ruleset_id']}'s checks for the branch creation only, then restores it"
                )
    plan.step(False, f"create {plan.branch} at {plan.rc_tag}")


def check_label(gh, plan):
    plan.label_done = gh.get(f"labels/{quote(plan.label, safe='')}") is not None
    plan.step(plan.label_done, f"create the {plan.label!r} label")


def check_config_pull(gh, plan):
    # The cut's own commit adds release-line.json, so its presence on the branch
    # means the configuration pull request merged.
    plan.config_done = bool(plan.branch_sha) and gh.file(RELEASE_LINE_PATH, plan.branch) is not None
    title = f"configure Release Please on {plan.branch} for {plan.version}"
    pull = plan.branch_sha and not plan.config_done and gh.open_pull(plan.config_head, plan.branch)
    plan.step(plan.config_done, f"{title}: #{pull['number']} is open" if pull else title)


def set_release_line():
    path = Path(__file__).with_name("set-release-line.py")
    spec = importlib.util.spec_from_file_location("set_release_line", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def next_line_dependabot(gh, plan):
    """main's dependabot.yml with the previous line's entries copied for the new one."""
    previous = f"release/{line_name(plan.previous)}"
    try:
        return set_release_line().add_line(gh.file(DEPENDABOT_PATH, "main"), previous, plan.branch)
    except ValueError as error:
        raise CutError(f"{DEPENDABOT_PATH} on main: {error}") from error


def check_next_rc(gh, plan):
    title = f"start {plan.next_rc} on main and point Dependabot at {plan.branch} too"
    manifest = json.loads(gh.file(MANIFEST_PATH, "main"))["platform"]
    override = release_as(gh.file(CONFIG_PATH, "main"))
    plan.next_rc_done = manifest.startswith(f"{plan.line[0]}.{plan.line[1] + 1}.") or override == plan.next_rc
    if not plan.next_rc_done:
        plan.notes.append(
            f"do not merge main's open release PR until the {plan.next_rc} pull request merges: "
            f"another {plan.version}-rc would ship main commits that {plan.branch} does not have"
        )
    if not plan.next_rc_done and override:
        plan.blockers.append(f"main already sets release-as {override}; release it or remove it first")
    if not plan.next_rc_done:
        try:
            next_line_dependabot(gh, plan)
        except CutError as error:
            plan.blockers.append(str(error))
    pull = not plan.next_rc_done and gh.open_pull(plan.next_rc_head, "main")
    plan.step(plan.next_rc_done, f"{title}: #{pull['number']} is open" if pull else title)


def check_upgrade_guide(gh, plan):
    guide = (
        f"docs/pages/admin/upgrade-v{plan.previous[0]}-{plan.previous[1]}"
        f"-to-v{plan.line[0]}-{plan.line[1]}.md"
    )
    text = gh.file(guide, plan.branch if plan.branch_sha else "main")
    if text is None:
        plan.notes.append(f"write {guide}: the {plan.version} release PR's Release Freeze Check needs it")
    elif re.search(r"^draft:\s*true\s*$", text.split("\n---", 1)[0], re.MULTILINE):
        plan.notes.append(f"finish {guide} on {plan.branch} and remove draft: true before merging the {plan.version} PR")


def cut(gh, plan):
    if not plan.branch_sha:
        create_branch(gh, plan)
    if not plan.label_done:
        previous = gh.get(f"labels/{quote(f'backport release/{line_name(plan.previous)}', safe='')}")
        gh.api("labels", {
            "name": plan.label,
            "color": previous["color"] if previous else "ededed",
            "description": f"Open a backport pull request to {plan.branch}",
        }, method="POST")
        print(f"Created the {plan.label!r} label")
    if not plan.config_done:
        record = {"line": line_name(plan.line), "previousLine": line_name(plan.previous), "cutFrom": plan.rc_tag}
        pull = gh.propose(
            plan.branch, plan.config_head,
            f"chore(release): configure {plan.branch} for the {plan.version} stable cut",
            f"Cut from `{plan.rc_tag}`. Release Please releases `{plan.version}` next; "
            f"`{RELEASE_LINE_PATH}` records the cut and changes `platform/`, which Release "
            f"Please needs to open the `{plan.version}` release PR. Made by "
            "`.github/scripts/stable-line.py cut`.",
            {
                CONFIG_PATH: stable_config(gh.file(CONFIG_PATH, plan.branch), plan.version),
                RELEASE_LINE_PATH: dump_json(record),
            },
        )
        print(f"{plan.branch} configuration: {pull['html_url']}")
    if not plan.next_rc_done:
        pull = gh.propose(
            "main", plan.next_rc_head,
            f"chore(release): start {plan.next_rc} on main",
            f"`{plan.branch}` is cut from `{plan.rc_tag}`, so main's next release candidate is "
            f"`{plan.next_rc}`. Release Please renames the open release candidate PR. Release "
            f"Finalize removes `release-as` once `{plan.next_rc}` publishes.\n\n"
            f"Dependabot also updates `{plan.branch}`, with the same entries as `release/{line_name(plan.previous)}`, "
            f"so `{plan.version}` gets the fixes the current line gets. Move Release Line removes the "
            f"`release/{line_name(plan.previous)}` entries once `{plan.version}` publishes. Made by "
            "`.github/scripts/stable-line.py cut`.",
            {
                CONFIG_PATH: release_as_config(gh.file(CONFIG_PATH, "main"), plan.next_rc),
                DEPENDABOT_PATH: next_line_dependabot(gh, plan),
            },
        )
        print(f"main {plan.next_rc}: {pull['html_url']}")
    print(
        f"Next: finish the upgrade guide on {plan.branch} and qualify the {plan.version} release PR. Before merging it, "
        f"run `stable-line.py handoff --line {line_name(plan.line)}`."
    )


def create_branch(gh, plan):
    originals = {rid: gh.api(f"rulesets/{rid}") for rid in plan.exemptions}
    try:
        for ruleset in originals.values():
            gh.api(f"rulesets/{ruleset['id']}", exempt_creation(ruleset, True), method="PUT")
        gh.api("git/refs", {"ref": f"refs/heads/{plan.branch}", "sha": plan.rc_commit}, method="POST")
    finally:
        restore(gh, originals.values())
    print(f"Created {plan.branch} at {plan.rc_commit}")


def restore(gh, rulesets):
    """Put every ruleset back as it was, then read each back; report all that failed."""
    failed = []
    for ruleset in rulesets:
        try:
            gh.api(f"rulesets/{ruleset['id']}", exempt_creation(ruleset, False), method="PUT")
            if exempt_creation(gh.api(f"rulesets/{ruleset['id']}"), False) != exempt_creation(ruleset, False):
                failed.append(f"{ruleset['id']} (read back differently)")
        except GitHubError as error:
            failed.append(f"{ruleset['id']} ({error})")
    if failed:
        raise CutError(f"rulesets did not restore: {', '.join(failed)}; re-apply the infra Terraform for github/org now")


def exempt_creation(ruleset, exempt):
    """The ruleset's update payload, with do_not_enforce_on_create set to `exempt`."""
    payload = {key: value for key, value in ruleset.items() if key not in RULESET_READ_ONLY}
    payload["rules"] = [
        {**rule, "parameters": {**rule["parameters"], "do_not_enforce_on_create": exempt}}
        if rule["type"] == "required_status_checks" else rule
        for rule in ruleset["rules"]
    ]
    return payload


def handoff(gh, line):
    branch = f"release/{line_name(line)}"
    text = gh.file(RELEASE_LINE_PATH, branch)
    if text is None:
        raise CutError(f"{branch} has no {RELEASE_LINE_PATH}; cut it with stable-line.py first")
    record = json.loads(text)
    previous = f"release/{record['previousLine']}"
    active = [
        run for status in ACTIVE_RUN_STATUSES
        for run in gh.api("actions/workflows/release-please.yml/runs", query={"branch": previous, "status": status})["workflow_runs"]
    ]
    if active:
        raise CutError(f"{previous} still has Release Please runs: {', '.join(run['html_url'] for run in active)}")
    # A finished run can still leave a release waiting for its publisher approval.
    pending = [
        r["tag_name"] for r in gh.pages("releases")
        if r["draft"] and re.fullmatch(rf"platform-v{re.escape(previous.removeprefix('release/'))}\.\d+", r["tag_name"])
    ]
    if pending:
        raise CutError(f"{previous} has unpublished releases: {', '.join(pending)}; publish or abandon them first")
    missing, by_hand = unported_backports(gh, previous, branch, record["cutFrom"])
    for pull in by_hand:
        print(f"check by hand that {branch} has #{pull['number']} {pull['title']}")
    if missing:
        raise CutError(
            f"{branch} lacks fixes {previous} got after the cut: "
            + ", ".join(f"#{source} (via #{pull['number']})" for source, pull in missing)
            + f"; cherry-pick -x each into {branch} through a pull request from "
            f"backport/{branch.replace('/', '-')}/pr-<main PR>, merge it, then rerun"
        )
    rulesets = [gh.api(f"rulesets/{summary['id']}") for summary in gh.pages("rulesets", {"includes_parents": "false"})]
    exact = [r for r in rulesets if r["enforcement"] == "active" and r["conditions"]["ref_name"]["include"] == [f"refs/heads/{previous}"]]
    queue = [r for r in exact if queue_rule(r)]
    read_only = [
        r for r in exact
        if not r["bypass_actors"]
        # GitHub may leave out the parameter at its default, false.
        and any(rule["type"] == "update" and not rule.get("parameters", {}).get("update_allows_fetch_and_merge", False) for rule in r["rules"])
    ]
    lines = f'"{previous.removeprefix("release/")}"'
    if queue:
        print(
            f"{branch} has every fix {previous} got after the cut. {previous} stays open. To lock it, move {lines} "
            f"from mergeQueue to readOnly in {INFRA_LINES}, label the pull request terraform-allow-destroy (it destroys "
            "the queue ruleset), merge, wait for Terraform apply, then rerun to close its open pull requests"
        )
        return
    if not read_only:
        raise CutError(f"{previous} has neither its merge queue nor a read-only ruleset: add {lines} to one list in {INFRA_LINES}")
    for pull in gh.pages("pulls", {"state": "open", "base": previous}):
        gh.api(
            f"issues/{pull['number']}/comments",
            {"body": f"`{previous}` is end of life: `{branch}` is the supported line. Closing; land the change on main and backport it to `{branch}` if it is still needed."},
            method="POST",
        )
        gh.api(f"pulls/{pull['number']}", {"state": "closed"}, method="PATCH")
        print(f"Closed #{pull['number']} {pull['title']}")
    print(f"{previous} is read-only and has no open pull requests")


def unported_backports(gh, previous, branch, cut_from):
    """Pull requests merged into `previous` after the cut whose change `branch` lacks.

    Open Backport PRs names its branches backport/<target>/pr-<main PR>, so a
    backport's source is known: `branch` has it when the source's merge commit
    is in its history or a backport of the same PR to `branch` merged. Returns
    (missing as (source, pull), pulls to check by hand). Release Please pull
    requests belong to the previous line alone.
    """
    cut_at = gh.api(f"commits/{gh.tag_commit(cut_from)}")["commit"]["committer"]["date"]
    merged = [
        pull for pull in gh.pages("pulls", {"state": "closed", "base": previous})
        if pull["merged_at"] and pull["merged_at"] > cut_at
    ]
    own = {
        pull["head"]["ref"] for pull in gh.pages("pulls", {"state": "closed", "base": branch}) if pull["merged_at"]
    }
    missing, by_hand = [], []
    for pull in merged:
        head = pull["head"]["ref"]
        source = re.fullmatch(rf"backport/{re.escape(previous.replace('/', '-'))}/pr-(\d+)", head)
        if source:
            ported = f"backport/{branch.replace('/', '-')}/pr-{source[1]}" in own
            sha = gh.api(f"pulls/{source[1]}")["merge_commit_sha"]
            if not ported and not (sha and gh.contains(sha, branch)):
                missing.append((source[1], pull))
        elif not head.startswith("release-please--"):
            by_hand.append(pull)
    return missing, by_hand


def stable_notes(gh, tag):
    """Prepend upgrade context to the X.Y.0 draft release: its changelog only covers the last RC."""
    match = STABLE_TAG.fullmatch(tag)
    if not match or match[3] != "0":
        raise CutError(f"{tag} is not a stable X.Y.0 tag")
    line = f"{match[1]}.{match[2]}"
    record = gh.file(RELEASE_LINE_PATH, tag)
    if record is None:
        raise CutError(f"{tag} has no {RELEASE_LINE_PATH}")
    record = json.loads(record)
    previous = record["previousLine"]
    releases = gh.pages("releases")
    draft = next((r for r in releases if r["tag_name"] == tag), None)
    if not draft:
        raise CutError(f"no release for {tag}")
    if NOTES_MARKER in (draft["body"] or ""):
        print(f"{tag} already has its upgrade notes")
        return
    # Only the candidates up to the one the line was cut from: a later main RC
    # carries commits the line does not have.
    cut_from = int(RC_TAG.fullmatch(record["cutFrom"])[3])
    candidates = sorted(
        (int(m[1]), r["html_url"]) for r in releases
        if not r["draft"] and (m := re.fullmatch(rf"platform-v{re.escape(line)}\.0-rc\.(\d+)", r["tag_name"]))
        and int(m[1]) <= cut_from
    )
    # The newest published previous-line release: what its installations run.
    previous_releases = [
        (int(m[1]), r["tag_name"]) for r in releases
        if not r["draft"] and (m := re.fullmatch(rf"platform-v{re.escape(previous)}\.(\d+)", r["tag_name"]))
    ]
    if not previous_releases:
        raise CutError(f"no published {previous}.Z release")
    previous_tag = max(previous_releases)[1]
    slug = f"upgrade-v{previous.replace('.', '-')}-to-v{line.replace('.', '-')}"
    links = " · ".join(f"[rc.{number}]({url})" for number, url in candidates)
    header = "\n".join([
        NOTES_MARKER,
        f"## Upgrading from {previous}",
        "",
        f"Read the [v{previous} to v{line} upgrade guide](https://archestra.ai/docs/v{line}/admin/{slug}) before you upgrade.",
        "",
        f"The changelog below covers only the changes since `{record['cutFrom'].removeprefix('platform-v')}`. "
        f"Everything else new in {line} shipped in its release candidates: {links}",
        "",
        f"All changes since {previous_tag.removeprefix('platform-v')}: "
        f"https://github.com/{gh.repo}/compare/{previous_tag}...{tag}",
        "",
        "---",
        "",
    ])
    body = header + (draft["body"] or "")
    if len(body) > RELEASE_BODY_LIMIT:
        # Publishing matters more than the header: GitHub would refuse the edit.
        print(f"::warning::{tag}'s changelog leaves no room for its upgrade notes; publishing it without them")
        return
    gh.api(f"releases/{draft['id']}", {"body": body}, method="PATCH")
    print(f"Added upgrade notes to {tag}")


def clear_release_as(gh, branch, version):
    """Once `version` publishes, drop the release-as that forced it, so Release Please continues."""
    config = gh.file(CONFIG_PATH, branch)
    if release_as(config) != version:
        print(f"{branch} does not set release-as {version}; nothing to clear")
        return
    pull = gh.propose(
        branch, f"automation/clear-release-as-{version}",
        f"chore(release): remove the consumed {version} release-as on {branch}",
        f"`{version}` is published, so Release Please no longer needs `release-as: {version}` on `{branch}`. "
        "Until it is removed, release-please.yml opens no next release PR. Made by "
        "`.github/scripts/stable-line.py clear-release-as` in Release Finalize.",
        {CONFIG_PATH: without_release_as(config)},
    )
    print(f"{branch}: {pull['html_url']}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "cut"):
        commands.add_parser(name).add_argument("--rc-tag", required=True)
    commands.add_parser("handoff").add_argument("--line", required=True, help="the new line, such as 1.5")
    commands.add_parser("stable-notes").add_argument("--tag", required=True)
    clear = commands.add_parser("clear-release-as")
    clear.add_argument("--branch", required=True)
    clear.add_argument("--version", required=True)
    args = parser.parse_args(argv)
    gh = GitHub(os.environ.get("GH_REPO", "archestra-ai/archestra"))
    try:
        if args.command in ("plan", "cut"):
            plan = build_plan(gh, args.rc_tag)
            plan.print()
            if plan.blockers:
                return 1
            if args.command == "cut":
                cut(gh, plan)
        elif args.command == "handoff":
            handoff(gh, parse_line(args.line))
        elif args.command == "stable-notes":
            stable_notes(gh, args.tag)
        else:
            clear_release_as(gh, args.branch, args.version)
    except (CutError, GitHubError, KeyError, ValueError) as error:
        print(f"stable-line {args.command}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
