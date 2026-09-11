"""Exercise real Git cherry-picks and pushes; fake only the GitHub API boundary."""

import importlib.util
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SPEC = importlib.util.spec_from_file_location("backport", Path(__file__).with_name("backport.py"))
backport = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backport)


class FakeGitHubBackporter(backport.Backporter):
    def __init__(self, checkout, pr):
        super().__init__("fixture/repository", checkout, ["release/1.3", "release/1.4"])
        self.pr = pr
        self.pulls = []
        self.comments = []

    def api(self, endpoint, payload=None, *, method=None, paginate=False):
        if endpoint == "repos/fixture/repository":
            return {"default_branch": "main"}
        if endpoint == "repos/fixture/repository/pulls/42":
            return self.pr
        if "pulls?" in endpoint:
            query = parse_qs(urlparse(endpoint).query)
            pulls = [pr for pr in self.pulls if pr["base"] == query["base"][0]]
            if "head" in query:
                return [pr for pr in pulls if pr["head"] == query["head"][0].split(":")[1]]
            return [{**pr, "head": {"ref": pr["head"], "repo": {"full_name": self.repo}}} for pr in pulls]
        if "issues?" in endpoint:
            label = parse_qs(urlparse(endpoint).query)["labels"][0]
            return [{"number": 42, "pull_request": {}, "updated_at": "2020-01-01T00:00:00Z"}] if any(item["name"] == label for item in self.pr["labels"]) else []
        if endpoint.endswith("/pulls") and payload:
            pr = {**payload, "state": "open", "html_url": "https://github.com/fixture/repository/pull/43"}
            self.pulls.append(pr)
            return pr
        if endpoint.endswith("/comments"):
            if payload:
                comment = {**payload, "id": len(self.comments) + 1, "user": {"type": "Bot"}}
                self.comments.append(comment)
                return comment
            return self.comments
        if "/issues/comments/" in endpoint and method == "PATCH":
            self.comments[int(endpoint.rsplit("/", 1)[1]) - 1].update(payload)
            return payload
        raise AssertionError((endpoint, payload, method, paginate))


class BackportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "checkout"
        self.remote = self.root / "remote.git"
        subprocess.run(["git", "init", "--bare", "-q", str(self.remote)], check=True)
        subprocess.run(["git", "clone", "-q", str(self.remote), str(self.repo)], check=True, capture_output=True)
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        self.git("checkout", "-b", "main")
        (self.repo / "feature.txt").write_text("original\n")
        self.commit("initial")
        self.git("push", "origin", "main:main", "main:release/1.3", "main:release/1.4")
        (self.repo / "feature.txt").write_text("fixed\n")
        sha = self.commit("fix: correct feature")
        self.git("push", "origin", "main")
        self.pr = {"number": 42, "title": "fix: correct feature", "merged": True,
                   "base": {"ref": "main"}, "merge_commit_sha": sha,
                   "labels": [{"name": "backport release/1.3"}]}
        self.bot = FakeGitHubBackporter(self.repo, self.pr)

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, stderr=subprocess.PIPE, text=True).strip()

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def test_label_before_merge_is_processed_by_later_scan_once(self):
        self.pr["merged"] = False
        self.bot.poll()
        self.assertEqual(self.bot.pulls, [])
        self.pr["merged"] = True
        self.bot.poll()
        self.bot.poll()
        self.assertEqual(len(self.bot.pulls), 1)
        self.assertEqual(self.bot.pulls[0]["base"], "release/1.3")

    def test_opens_a_backport_with_provenance_without_changing_stable(self):
        stable = self.git("rev-parse", "origin/release/1.3")
        self.bot.run(42)
        self.assertEqual(len(self.bot.pulls), 1)
        pr = self.bot.pulls[0]
        self.assertEqual(pr["base"], "release/1.3")
        self.assertNotIn("draft", pr)
        self.git("fetch", "origin")
        ref = "origin/backport/release-1.3/pr-42"
        self.assertEqual(self.git("show", ref + ":feature.txt"), "fixed")
        self.assertIn(f"(cherry picked from commit {self.pr['merge_commit_sha']})", self.git("show", "-s", "--format=%B", ref))
        self.assertEqual(self.git("rev-parse", "origin/release/1.3"), stable)
        self.assertEqual(self.git("branch", "--show-current"), "main")
        self.assertEqual(len(self.git("worktree", "list", "--porcelain").split("worktree ")) - 1, 1)

    def test_duplicate_event_and_closed_pr_do_not_create_duplicates(self):
        self.bot.run(42)
        self.bot.pulls[0]["state"] = "closed"
        self.bot.run(42)
        self.assertEqual(len(self.bot.pulls), 1)
        self.assertEqual(len(self.bot.comments), 1)

    def test_resumes_after_push_succeeded_but_pr_creation_failed(self):
        self.bot.create_branch(target="release/1.3", branch="backport/release-1.3/pr-42",
                               sha=self.pr["merge_commit_sha"], is_merge=False)
        self.bot.run(42)
        self.assertEqual(len(self.bot.pulls), 1)

    def test_conflict_reports_manual_action_without_pushing(self):
        self.git("checkout", "-b", "stable", "origin/release/1.3")
        (self.repo / "feature.txt").write_text("stable changed independently\n")
        self.commit("fix: stable divergence")
        self.git("push", "origin", "HEAD:release/1.3")
        self.git("checkout", "main")
        self.bot.run(42)
        self.bot.run(42)
        self.assertEqual(self.bot.pulls, [])
        self.assertEqual(len(self.bot.comments), 1)
        self.assertIn("conflicts", self.bot.comments[0]["body"])
        self.assertEqual(self.git("ls-remote", "--heads", "origin", "refs/heads/backport/*"), "")

    def test_schema_changes_are_not_automatically_backported(self):
        schema = self.repo / "platform/backend/src/database/migrations/0001_change.sql"
        schema.parent.mkdir(parents=True)
        schema.write_text("ALTER TABLE example ADD COLUMN value text;")
        self.pr["merge_commit_sha"] = self.commit("fix: schema change")
        self.git("push", "origin", "main")
        self.bot.run(42)
        self.assertEqual(self.bot.pulls, [])
        self.assertIn("schema migrations", self.bot.comments[0]["body"])

    def test_unmerged_or_non_main_source_is_rejected(self):
        self.pr["merged"] = False
        with self.assertRaisesRegex(ValueError, "Only merged"):
            self.bot.run(42)
        self.pr["merged"] = True
        self.pr["base"]["ref"] = "release/1.3"
        with self.assertRaisesRegex(ValueError, "Only merged"):
            self.bot.run(42)

    def test_no_label_is_noop_and_labels_added_after_merge_work(self):
        self.pr["labels"] = []
        self.bot.run(42)
        self.assertEqual(self.bot.pulls, [])
        self.pr["labels"] = [{"name": "backport release/1.3"}, {"name": "backport release/1.4"}]
        self.bot.run(42)
        self.assertEqual({pr["base"] for pr in self.bot.pulls}, {"release/1.3", "release/1.4"})

    def test_unknown_target_is_not_pushed(self):
        self.bot.run(42, "release/9.9")
        self.assertEqual(self.bot.pulls, [])
        self.assertIn("not enabled", self.bot.comments[0]["body"])

    def test_existing_unrelated_branch_is_not_overwritten(self):
        self.git("push", "origin", "origin/release/1.3:refs/heads/backport/release-1.3/pr-42")
        self.bot.run(42)
        self.assertEqual(self.bot.pulls, [])
        self.assertIn("already exists", self.bot.comments[0]["body"])

    def test_already_present_patch_does_not_open_empty_pr(self):
        self.git("push", "origin", "main:release/1.3")
        self.bot.run(42)
        self.assertEqual(self.bot.pulls, [])
        self.assertIn("already present", self.bot.comments[0]["body"])

    def test_merge_commit_cherry_picks_first_parent_diff(self):
        self.git("checkout", "-b", "feature")
        (self.repo / "merge-feature.txt").write_text("feature\n")
        self.commit("fix: merged feature")
        self.git("checkout", "main")
        (self.repo / "main-only.txt").write_text("main only\n")
        self.commit("feat: main only")
        self.git("merge", "--no-ff", "feature", "-m", "fix: merge feature")
        self.pr["merge_commit_sha"] = self.git("rev-parse", "HEAD")
        self.git("push", "origin", "main")
        self.bot.run(42)
        self.git("fetch", "origin")
        ref = "origin/backport/release-1.3/pr-42"
        self.assertEqual(self.git("show", ref + ":merge-feature.txt"), "feature")
        self.assertEqual(self.git("show", ref + ":feature.txt"), "original")

    def test_poll_recovers_old_label_requests_and_skips_existing_backports(self):
        self.bot.poll()
        self.bot.poll()
        self.assertEqual(len(self.bot.pulls), 1)
        self.assertEqual(len(self.bot.comments), 1)

    def test_poll_ignores_closed_unmerged_requests(self):
        self.pr["merged"] = False
        self.bot.poll()
        self.assertEqual(self.bot.pulls, [])

    def test_untrusted_title_is_data_not_shell_code(self):
        self.pr["title"] = "fix: $(touch SHOULD_NOT_EXIST) `touch ALSO_NOT_EXIST`"
        self.bot.run(42)
        self.assertFalse((self.repo / "SHOULD_NOT_EXIST").exists())
        self.assertFalse((self.repo / "ALSO_NOT_EXIST").exists())
        self.assertIn("$(touch", self.bot.pulls[0]["title"])


class WorkflowPolicyTests(unittest.TestCase):
    def test_event_gate_only_allows_trusted_merged_backport_requests(self):
        workflow = Path(__file__).parents[1] / "workflows/backport.yml"
        condition = next(line.split("if: ", 1)[1] for line in workflow.read_text().splitlines()
                         if line.startswith("    if: "))
        program = r"""
const vm = require('node:vm');
const assert = require('node:assert/strict');
const condition = process.argv[1];
function allowed(eventName, {merged = true, base = 'main', label = 'backport release/1.3', repo = 'archestra-ai/archestra'} = {}) {
  const github = {repository: repo, event_name: eventName, event: {repository:{default_branch:'main'}}};
  if (eventName === 'pull_request_target') {
    github.event.pull_request = {merged, base:{ref:base}, head:{repo:{full_name:'contributor/fork'}}};
    github.event.label = {name:label};
  }
  return vm.runInNewContext(condition, {github, startsWith:(value, prefix) => value.startsWith(prefix)});
}
for (const eventName of ['push', 'schedule', 'workflow_dispatch', 'pull_request_target']) {
  assert.equal(allowed(eventName), true, eventName);
  assert.equal(allowed(eventName, {repo:'contributor/fork'}), false, eventName);
}
assert.equal(allowed('pull_request_target', {merged:false}), false);
assert.equal(allowed('pull_request_target', {base:'release/1.3'}), false);
assert.equal(allowed('pull_request_target', {label:'bug'}), false);
assert.equal(allowed('pull_request_target', {label:'not-backport release/1.3'}), false);
"""
        subprocess.run(["node", "-e", program, condition], check=True)

    def test_backport_prs_run_checks_while_release_bot_prs_remain_exempt(self):
        workflow = Path(__file__).parents[1] / "workflows/on-pull-requests.yml"
        conditions = [line.split("if: ", 1)[1] for line in workflow.read_text().splitlines()
                      if "if: " in line and "archestra-ci[bot]" in line]
        self.assertTrue(conditions)
        program = r"""
const vm = require('node:vm');
const assert = require('node:assert/strict');
const conditions = JSON.parse(process.argv[1]);
for (const condition of conditions) {
  for (const [login, ref, expected] of [
    ['archestra-ci[bot]', 'backport/release-1.3/pr-42', true],
    ['archestra-ci[bot]', 'release-please--branches--main', false],
    ['contributor', 'fix/example', true],
    ['archestra-contributor-pr-bot[bot]', 'docs/example', false],
  ]) {
    const context = {github: {event_name: 'pull_request', event: {pull_request: {user: {login}, head: {ref}}}},
      startsWith: (value, prefix) => value.startsWith(prefix), always: () => true};
    assert.equal(vm.runInNewContext(condition, context), expected, condition);
  }
  assert.equal(vm.runInNewContext(condition, {github: {event_name:'merge_group'}, always: () => true}), true);
}
"""
        subprocess.run(["node", "-e", program, json.dumps(conditions)], check=True)

    def test_backport_bot_prs_receive_reviewers(self):
        workflow = Path(__file__).parents[1] / "workflows/random-issue-pr-assignee.yml"
        condition = re.search(r"if \((exemptLogins\.includes[\s\S]*?)\) \{", workflow.read_text()).group(1)
        program = r"""
const vm = require('node:vm');
const assert = require('node:assert/strict');
for (const [ref, expectedExempt] of [['backport/release-1.3/pr-42', false], ['release-please--main', true]]) {
 assert.equal(vm.runInNewContext(process.argv[1], {exemptLogins:['archestra-ci[bot]'], pr:{user:{login:'archestra-ci[bot]'},head:{ref}}}), expectedExempt);
}
"""
        subprocess.run(["node", "-e", program, condition], check=True)


if __name__ == "__main__":
    unittest.main()
