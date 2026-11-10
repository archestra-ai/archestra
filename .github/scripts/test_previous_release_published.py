"""Exercise previous-release-published.py, stubbing only the GitHub API."""

import importlib.util
import json
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("previous_release_published",
                                              Path(__file__).with_name("previous-release-published.py"))
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)

REPO = "archestra-ai/archestra"
WORKFLOW = "previous-release-published.yml"


def pull(number, title, base, head="release-please--branches--main--components--platform", sha="abc"):
    return {"number": number, "title": title, "base": {"ref": base}, "head": {"ref": head, "sha": sha}}


MAIN_PR = pull(10517, "chore(main): release platform 1.5.0-rc.29", "main")
STABLE_PR = pull(10521, "chore(release/1.4): release platform 1.4.27", "release/1.4",
                 head="release-please--branches--release/1.4--components--platform", sha="def")
FEATURE_PR = pull(10600, "feat: something", "main", head="feature/something", sha="123")


class FakeGitHub:
    """Tags, releases, PRs, comments and runs, answered like the REST API."""

    def __init__(self, published=(), drafts=(), pulls=(), comments=(), runs=None, commits=()):
        self.repository = REPO
        self.published = set(published)
        self.drafts = set(drafts)
        self.pulls = {item["number"]: item for item in pulls}
        self.comments = [dict(comment) for comment in comments]
        self.runs = runs or {}
        self.commits = list(commits)
        self.sent = []

    def get(self, path):
        prefix = f"repos/{REPO}/"
        assert path.startswith(prefix), path
        path = path[len(prefix):]
        if path.startswith("pulls/"):
            return self.pulls[int(path.split("/")[1])]
        if path.startswith(f"actions/workflows/{CHECK.RELEASE_WORKFLOW}/runs"):
            sha = path.split("head_sha=")[1].split("&")[0]
            return {"workflow_runs": [{"html_url": f"https://github.com/{REPO}/actions/runs/{sha}"}]}
        if path.startswith(f"actions/workflows/{WORKFLOW}/runs"):
            sha = path.split("head_sha=")[1].split("&")[0]
            return {"workflow_runs": self.runs.get(sha, [])}
        if path.startswith("compare/"):
            return {"commits": [{"commit": {"message": message}} for message in self.commits]}
        raise AssertionError(path)

    def get_optional(self, path):
        assert path.startswith(f"repos/{REPO}/git/ref/tags/"), path
        return {"object": {"type": "commit", "sha": "sha-" + path.rsplit("/", 1)[1]}}

    def lines(self, path, jq):
        path = path[len(f"repos/{REPO}/"):]
        if path.startswith("releases?"):
            return [json.dumps([tag, tag in self.drafts]) for tag in sorted(self.published | self.drafts)]
        if path.startswith("issues/"):
            return [json.dumps({"id": comment["id"], "body": comment["body"]}) for comment in self.comments
                    if comment["user"] == CHECK.COMMENT_AUTHOR and CHECK.COMMENT_MARKER in comment["body"]]
        if path.startswith("pulls?state=open"):
            return [json.dumps(item) for item in self.pulls.values()
                    if item["head"]["ref"].startswith(CHECK.RELEASE_HEAD)]
        raise AssertionError(path)

    def send(self, method, path, body=None):
        self.sent.append((method, path[len(f"repos/{REPO}/"):], body))
        if method == "POST" and path.endswith("/comments"):
            self.comments.append({"id": 900 + len(self.comments), "user": CHECK.COMMENT_AUTHOR, "body": body["body"]})
        if method == "PATCH":
            comment_id = int(path.rsplit("/", 1)[1])
            next(comment for comment in self.comments if comment["id"] == comment_id)["body"] = body["body"]
        return {}


def tags(*versions):
    return [f"platform-v{version}" for version in versions]


class LineTests(unittest.TestCase):
    def test_release_candidates_sort_before_their_release_and_numerically(self):
        ordered = ["1.4.9", "1.4.10", "1.5.0-rc.2", "1.5.0-rc.10", "1.5.0", "1.5.1", "1.6.0-rc.1"]
        self.assertEqual(sorted(reversed(ordered), key=CHECK.version_key), ordered)

    def test_main_releases_candidates_and_release_branches_their_minor(self):
        self.assertEqual(CHECK.release_line("1.5.0-rc.29"), "main")
        self.assertEqual(CHECK.release_line("1.4.27"), "release/1.4")
        self.assertEqual(CHECK.release_line("1.10.0"), "release/1.10")

    def test_rejects_versions_the_release_policy_never_makes(self):
        for version in ("", "latest", "1.5", "1.5.0-beta.1", "v1.5.0", "1.5.0-rc.1; rm -rf /"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                CHECK.version_key(version)


class ReleaseTargetTests(unittest.TestCase):
    def test_reads_base_and_version_from_release_please_prs(self):
        self.assertEqual(CHECK.release_target(MAIN_PR), ("main", "1.5.0-rc.29"))
        self.assertEqual(CHECK.release_target(STABLE_PR), ("release/1.4", "1.4.27"))

    def test_other_prs_are_not_release_prs(self):
        self.assertIsNone(CHECK.release_target(FEATURE_PR))
        self.assertIsNone(CHECK.release_target(pull(1, "chore(main): release platform 1.5.0-rc.29", "main",
                                                    head="joey/release-please-tweaks")))

    def test_a_release_pr_that_cannot_be_read_fails_closed(self):
        for item in (pull(1, "chore(main): release platform", "main"),
                     pull(2, "chore(release/1.4): release platform 1.4.27", "main"),
                     pull(3, "chore(main): release platform 1.5.0", "main"),
                     pull(4, "chore(release/1.4): release platform 1.3.82", "release/1.4")):
            with self.subTest(title=item["title"]), self.assertRaises(ValueError):
                CHECK.release_target(item)


class DraftsBeforeTests(unittest.TestCase):
    def drafts(self, version, published=(), drafts=()):
        releases = [(tag, False) for tag in tags(*published)] + [(tag, True) for tag in tags(*drafts)]
        return CHECK.drafts_before(version, releases)

    def test_waits_for_the_previous_candidate_on_main(self):
        self.assertEqual(self.drafts("1.5.0-rc.29", published=("1.5.0-rc.26", "1.5.0-rc.27", "1.4.25"),
                                     drafts=("1.5.0-rc.28", "1.4.26")), ["1.5.0-rc.28"])

    def test_waits_for_the_previous_patch_on_its_release_branch_only(self):
        self.assertEqual(self.drafts("1.4.27", published=("1.4.25",), drafts=("1.3.82", "1.4.26", "1.5.0-rc.28")),
                         ["1.4.26"])

    def test_names_every_draft_since_the_newest_published_release(self):
        self.assertEqual(self.drafts("1.5.0-rc.13", published=("1.5.0-rc.9",),
                                     drafts=("1.5.0-rc.10", "1.5.0-rc.11", "1.5.0-rc.12")),
                         ["1.5.0-rc.12", "1.5.0-rc.11", "1.5.0-rc.10"])

    def test_main_is_one_line_across_minors(self):
        self.assertEqual(self.drafts("1.6.0-rc.1", drafts=("1.5.0-rc.40",)), ["1.5.0-rc.40"])

    def test_clear_when_the_previous_release_is_published_or_its_draft_deleted(self):
        self.assertEqual(self.drafts("1.5.0-rc.29", published=("1.5.0-rc.27", "1.5.0-rc.28")), [])
        # A rejected 1.4.0 keeps its tag but loses its draft; 1.4.1 replaces it.
        self.assertEqual(self.drafts("1.4.1"), [])

    def test_a_stale_draft_behind_a_published_release_holds_nothing(self):
        self.assertEqual(self.drafts("1.4.25", published=("1.4.22", "1.4.24"), drafts=("1.4.23",)), [])

    def test_the_first_release_of_a_line_and_newer_drafts_hold_nothing(self):
        self.assertEqual(self.drafts("1.5.0", drafts=("1.5.0-rc.40", "1.4.26")), [])
        self.assertEqual(self.drafts("1.5.0-rc.29", drafts=("1.5.0-rc.29", "1.5.0-rc.30")), [])

    def test_ignores_other_releases(self):
        releases = [("platform-vnext", True), ("v1.5.0-rc.28", True), ("platform-v1.5.0-rc.27", False)]
        self.assertEqual(CHECK.drafts_before("1.5.0-rc.29", releases), [])


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.github = FakeGitHub(published=tags("1.5.0-rc.27", "1.4.25"),
                                 drafts=tags("1.5.0-rc.28", "1.4.26"),
                                 pulls=[MAIN_PR, STABLE_PR, FEATURE_PR])

    def check_pr(self, number):
        return CHECK.check(self.github, {"PR_NUMBER": str(number)})

    def test_blocks_and_comments_once_naming_the_draft_and_its_run(self):
        self.assertFalse(self.check_pr(10517))
        self.assertFalse(self.check_pr(10517))
        posts = [sent for sent in self.github.sent if sent[0] == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0][1], "issues/10517/comments")
        body = self.github.comments[0]["body"]
        self.assertIn("**1.5.0-rc.28**", body)
        self.assertIn(f"https://github.com/{REPO}/actions/runs/sha-platform-v1.5.0-rc.28", body)
        self.assertIn(CHECK.PUBLISHER_WAITING_URL, body)
        self.assertNotIn("1.4.26", body)

    def test_rewrites_the_same_comment_when_unblocked(self):
        self.check_pr(10517)
        self.github.drafts.discard("platform-v1.5.0-rc.28")
        self.github.published.add("platform-v1.5.0-rc.28")
        self.assertTrue(self.check_pr(10517))
        self.assertEqual(len(self.github.comments), 1)
        self.assertIn("Unblocked", self.github.comments[0]["body"])
        self.assertEqual([sent[0] for sent in self.github.sent], ["POST", "PATCH"])

    def test_never_blocked_prs_get_no_comment(self):
        self.github.drafts.discard("platform-v1.5.0-rc.28")
        self.github.published.add("platform-v1.5.0-rc.28")
        self.assertTrue(self.check_pr(10517))
        self.assertTrue(self.check_pr(10600))
        self.assertEqual(self.github.sent, [])

    def test_ignores_comments_others_wrote_with_the_marker(self):
        self.github.comments = [{"id": 1, "user": "someone", "body": CHECK.COMMENT_MARKER + " quoted"}]
        self.check_pr(10517)
        self.assertEqual([sent[0] for sent in self.github.sent], ["POST"])

    def merge_group(self, head_ref, commits):
        self.github.commits = commits
        return CHECK.check(self.github, {"MERGE_GROUP_BASE_SHA": "base", "MERGE_GROUP_HEAD_SHA": "head",
                                         "MERGE_GROUP_HEAD_REF": head_ref})

    def test_merge_group_checks_every_release_pr_it_merges(self):
        ref = "refs/heads/gh-readonly-queue/main/pr-10600-a588ee2b194172b4ee85c5db72b98df6c300a66c"
        self.assertTrue(self.merge_group(ref, ["feat: something (#10600)"]))
        self.assertFalse(self.merge_group(ref, ["chore(main): release platform 1.5.0-rc.29 (#10517)\n\nbody",
                                                "feat: something (#10600)"]))
        self.github.drafts.discard("platform-v1.5.0-rc.28")
        self.github.published.add("platform-v1.5.0-rc.28")
        self.assertTrue(self.merge_group(ref.replace("10600", "10517"), []))
        self.assertEqual(self.github.sent, [])


class RecheckTests(unittest.TestCase):
    def run_list(self, conclusion, status="completed", event="pull_request"):
        return [{"id": 77, "event": event, "status": status, "conclusion": conclusion,
                 "html_url": f"https://github.com/{REPO}/actions/runs/77"}]

    def recheck(self, github):
        return CHECK.recheck(github, {"WORKFLOW_FILE": WORKFLOW})

    def test_reruns_failed_checks_of_release_prs_that_are_now_clear(self):
        github = FakeGitHub(published=tags("1.5.0-rc.28"), drafts=tags("1.4.26"),
                            pulls=[MAIN_PR, STABLE_PR, FEATURE_PR],
                            runs={"abc": self.run_list("failure"), "def": self.run_list("failure")})
        self.assertEqual(self.recheck(github), [10517])
        self.assertEqual(github.sent, [("POST", "actions/runs/77/rerun-failed-jobs", None)])

    def test_leaves_passing_running_and_still_blocked_checks_alone(self):
        for runs in ({"abc": self.run_list("success")}, {"abc": self.run_list(None, status="in_progress")},
                     {"abc": self.run_list("failure", event="schedule")}, {}):
            with self.subTest(runs=runs):
                github = FakeGitHub(published=tags("1.5.0-rc.28"), pulls=[MAIN_PR],
                                    runs=runs)
                self.assertEqual(self.recheck(github), [])
        github = FakeGitHub(drafts=tags("1.5.0-rc.28"), pulls=[MAIN_PR], runs={"abc": self.run_list("failure")})
        self.assertEqual(self.recheck(github), [])
        self.assertEqual(github.sent, [])


if __name__ == "__main__":
    unittest.main()
