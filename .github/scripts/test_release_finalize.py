"""Exercise release-finalize.py, stubbing only the GitHub API and artifact download."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("release_finalize", Path(__file__).with_name("release-finalize.py"))
FINALIZE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FINALIZE)

REPO = "archestra-ai/archestra"
PUBLISHER = "archestra-ai/release-publisher"
BOT = "archestra-releaser[bot]"


def source_run(run_id=90, **overrides):
    run = {"id": run_id, "path": ".github/workflows/release-please.yml", "head_branch": "main", "event": "push",
           "run_attempt": 2, "repository": {"full_name": REPO}}
    run.update(overrides)
    return run


def publisher_run(version, request_id, created, conclusion="success", status="completed", actor=BOT):
    return {"display_title": f"Publish archestra {version} [{request_id}]", "created_at": created,
            "status": status, "conclusion": conclusion, "triggering_actor": {"login": actor},
            "html_url": f"https://github.com/{PUBLISHER}/actions/runs/{request_id}"}


class Api:
    def __init__(self, runs=None, releases=None, publisher_runs=()):
        self.runs = runs or {90: source_run()}
        self.releases = releases if releases is not None else [
            {"tag_name": "platform-v1.5.0-rc.27", "draft": True}]
        self.publisher_runs = list(publisher_runs)
        self.tokens = []

    def __call__(self, path, token=None):
        self.tokens.append((path, token))
        if path.startswith(f"repos/{REPO}/actions/runs/"):
            return self.runs[int(path.rsplit("/", 1)[1])]
        if path.startswith(f"repos/{REPO}/releases"):
            return self.releases
        if path.startswith(f"repos/{PUBLISHER}/actions/workflows/publish.yml/runs"):
            return {"workflow_runs": self.publisher_runs}
        raise AssertionError(path)


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.request = {"project": "archestra", "request_id": "90-2", "version": "1.5.0-rc.27",
                        "images": {"docker.io/archestra/platform": "sha256:" + "a" * 64}}
        self.fetched = []

    def fetch(self, repository, run_id, name, directory):
        self.fetched.append((repository, run_id, name))
        (Path(directory) / "request.json").write_text(json.dumps(self.request))

    def resolve(self, api, request_id="90-2", branch="main"):
        return FINALIZE.resolve(REPO, branch, request_id, self.directory, request=api, fetch=self.fetch)

    def test_reads_the_kept_request_of_that_attempt(self):
        result = self.resolve(Api())
        self.assertEqual(self.fetched, [(REPO, 90, "release-request-2")])
        self.assertEqual(result["tag_name"], "platform-v1.5.0-rc.27")
        self.assertTrue(result["publish"])

    def test_an_earlier_attempt_of_a_rerun_is_still_its_run(self):
        result = self.resolve(Api(runs={90: source_run(run_attempt=3)}))
        self.assertEqual(result["attempt"], 2)

    def test_a_published_release_needs_nothing(self):
        api = Api(releases=[{"tag_name": "platform-v1.5.0-rc.27", "draft": False}])
        self.assertFalse(self.resolve(api)["publish"])

    def test_only_this_repositorys_release_run_on_this_branch(self):
        for run, branch in (
            (source_run(head_branch="release/1.4"), "main"),
            (source_run(path=".github/workflows/other.yml"), "main"),
            (source_run(event="pull_request"), "main"),
            (source_run(run_attempt=1), "main"),
            (source_run(repository={"full_name": "someone/archestra"}), "main"),
            (source_run(head_branch="feature"), "feature"),
        ):
            with self.subTest(run=run, branch=branch), self.assertRaises(ValueError):
                self.resolve(Api(runs={90: run}), branch=branch)
        self.assertEqual(self.fetched, [])

    def test_the_kept_request_must_be_this_archestra_release(self):
        for change in ({"project": "openappa"}, {"request_id": "90-1"}, {"version": "latest"}, {"smoke": True}):
            with self.subTest(change=change):
                self.request = {**self.request, **change}
                with self.assertRaises(ValueError):
                    self.resolve(Api())
                self.request = {"project": "archestra", "request_id": "90-2", "version": "1.5.0-rc.27"}

    def test_malformed_request_ids_read_nothing(self):
        for request_id in ("", "90", "90-0", "abc-1", "90-2; rm -rf /"):
            with self.subTest(request_id=request_id), self.assertRaises(ValueError):
                self.resolve(Api(), request_id=request_id)
        self.assertEqual(self.fetched, [])

    def test_a_release_without_its_draft_fails(self):
        with self.assertRaisesRegex(ValueError, "No release platform-v1.5.0-rc.27"):
            self.resolve(Api(releases=[]))


class SweepTests(unittest.TestCase):
    def sweep(self, api):
        return FINALIZE.sweep(REPO, PUBLISHER, "publisher-token", request=api)

    def test_finds_drafts_whose_newest_request_succeeded_on_their_branch(self):
        api = Api(
            runs={90: source_run(), 95: source_run(95, head_branch="release/1.4")},
            releases=[{"tag_name": "platform-v1.5.0-rc.27", "draft": True},
                      {"tag_name": "platform-v1.4.25", "draft": True},
                      {"tag_name": "platform-v1.4.24", "draft": False}],
            publisher_runs=[
                publisher_run("1.5.0-rc.27", "90-2", "2026-11-09T12:00:00Z"),
                publisher_run("1.5.0-rc.27", "90-1", "2026-11-08T12:00:00Z", conclusion="cancelled"),
                publisher_run("1.4.25", "95-2", "2026-11-09T12:00:00Z"),
                publisher_run("1.4.24", "80-1", "2026-11-07T12:00:00Z"),
            ])
        self.assertEqual(self.sweep(api), [("release/1.4", "95-2"), ("main", "90-2")])
        self.assertIn((f"repos/{PUBLISHER}/actions/workflows/publish.yml/runs"
                       "?event=repository_dispatch&branch=main&per_page=100", "publisher-token"), api.tokens)

    def test_an_older_success_does_not_finish_a_newer_failed_or_waiting_request(self):
        for conclusion, status in (("failure", "completed"), (None, "waiting")):
            with self.subTest(status=status, conclusion=conclusion):
                api = Api(publisher_runs=[
                    publisher_run("1.5.0-rc.27", "90-1", "2026-11-08T12:00:00Z"),
                    publisher_run("1.5.0-rc.27", "90-2", "2026-11-09T12:00:00Z", conclusion=conclusion,
                                  status=status)])
                self.assertEqual(self.sweep(api), [])

    def test_ignores_runs_another_requester_started(self):
        api = Api(publisher_runs=[publisher_run("1.5.0-rc.27", "90-2", "2026-11-09T12:00:00Z", actor="someone")])
        self.assertEqual(self.sweep(api), [])

    def test_no_drafts_reads_no_publisher_runs(self):
        api = Api(releases=[{"tag_name": "platform-v1.5.0-rc.27", "draft": False}])
        self.assertEqual(self.sweep(api), [])
        self.assertFalse([path for path, _ in api.tokens if PUBLISHER in path])



class OpenRequestTests(unittest.TestCase):
    def open_request(self, *runs, version="1.5.0-rc.29"):
        api = Api(publisher_runs=runs)
        found = FINALIZE.open_request(PUBLISHER, version, "publisher-token", request=api)
        self.assertEqual(api.tokens, [(f"repos/{PUBLISHER}/actions/workflows/publish.yml/runs"
                                       "?event=repository_dispatch&branch=main&per_page=100", "publisher-token")])
        return found

    def test_a_request_still_waiting_or_queued_behind_it_is_open(self):
        for status in ("waiting", "pending", "queued", "in_progress"):
            with self.subTest(status=status):
                found = self.open_request(
                    publisher_run("1.5.0-rc.29", "92-1", "2026-11-10T20:00:00Z", conclusion="cancelled"),
                    publisher_run("1.5.0-rc.29", "90-1", "2026-11-10T18:00:00Z", conclusion=None, status=status))
                self.assertEqual(found, f"https://github.com/{PUBLISHER}/actions/runs/90-1")

    def test_finished_requests_leave_the_draft_to_recover(self):
        # Cancelled (an expired approval included), failed or rejected: recovery requests it again.
        self.assertIsNone(self.open_request(
            publisher_run("1.5.0-rc.29", "90-1", "2026-11-10T18:00:00Z", conclusion="cancelled"),
            publisher_run("1.5.0-rc.29", "91-1", "2026-11-10T19:00:00Z", conclusion="failure")))

    def test_only_this_versions_requests_from_the_release_app_count(self):
        self.assertIsNone(self.open_request(
            publisher_run("1.4.27", "95-1", "2026-11-10T18:00:00Z", conclusion=None, status="waiting"),
            publisher_run("1.5.0-rc.29", "90-1", "2026-11-10T18:00:00Z", conclusion=None, status="waiting",
                          actor="someone")))


if __name__ == "__main__":
    unittest.main()
