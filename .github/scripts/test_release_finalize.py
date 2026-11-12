"""Exercise release-finalize.py, stubbing only the GitHub API and artifact download."""

import importlib.util
import json
from pathlib import Path
import re
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



SHA = "d" * 40
NOW = FINALIZE.dt.datetime(2026, 11, 11, 18, 0, tzinfo=FINALIZE.dt.timezone.utc)
HELD = f"release-held-1.5.0-rc.29-{SHA}"


def held(run_id, created, branch="main", expired=False, name=HELD):
    return {"name": name, "created_at": created, "expired": expired,
            "workflow_run": {"id": run_id, "head_branch": branch}}


class HoldApi(Api):
    def __init__(self, held_artifacts=(), run_artifacts=(), publisher_error=None, **kwargs):
        super().__init__(**kwargs)
        self.held_artifacts = list(held_artifacts)
        self.run_artifacts = list(run_artifacts)
        self.publisher_error = publisher_error

    def __call__(self, path, token=None):
        if path.startswith(f"repos/{REPO}/actions/artifacts?"):
            self.tokens.append((path, token))
            name = path.split("name=", 1)[1].split("&", 1)[0]
            return {"artifacts": [row for row in self.held_artifacts if row["name"] == name]}
        if "/artifacts?" in path and path.startswith(f"repos/{REPO}/actions/runs/"):
            self.tokens.append((path, token))
            page = int(path.rsplit("page=", 1)[1])
            return {"artifacts": self.run_artifacts[(page - 1) * 100:page * 100]}
        if self.publisher_error and path.startswith(f"repos/{PUBLISHER}/"):
            raise self.publisher_error
        return super().__call__(path, token)


class RecoveryHoldTests(unittest.TestCase):
    """A push recovers a draft release only when a recovery can help."""

    def hold(self, api, created="2026-11-11T09:00:00Z", retry=False, branch="main"):
        self.warnings = []
        return FINALIZE.recovery_hold(REPO, branch, "1.5.0-rc.29", SHA, created, PUBLISHER, "publisher-token",
                                      retry_held=retry, request=api, now=NOW, warn=self.warnings.append)

    def test_a_draft_with_no_request_or_hold_is_recovered(self):
        # A failed or cancelled request (an expired approval included) is retried.
        api = HoldApi(publisher_runs=[
            publisher_run("1.5.0-rc.29", "90-1", "2026-11-11T10:00:00Z", conclusion="cancelled"),
            publisher_run("1.5.0-rc.29", "91-1", "2026-11-11T11:00:00Z", conclusion="failure")])
        self.assertIsNone(self.hold(api))

    def test_a_request_still_waiting_or_queued_behind_it_is_open(self):
        for status in ("waiting", "pending", "queued", "in_progress"):
            with self.subTest(status=status):
                kind, reason = self.hold(HoldApi(publisher_runs=[
                    publisher_run("1.5.0-rc.29", "92-1", "2026-11-11T12:00:00Z", conclusion="cancelled"),
                    publisher_run("1.5.0-rc.29", "90-1", "2026-11-11T10:00:00Z", conclusion=None, status=status)]))
                self.assertEqual(kind, "open")
                self.assertIn(f"https://github.com/{PUBLISHER}/actions/runs/90-1", reason)

    def test_a_succeeded_request_waits_for_finalize_instead_of_requesting_again(self):
        # The publish succeeded but the draft is not published yet; a newer
        # duplicate request that was cancelled does not reopen recovery.
        kind, reason = self.hold(HoldApi(publisher_runs=[
            publisher_run("1.5.0-rc.29", "95-1", "2026-11-11T13:00:00Z", conclusion="cancelled"),
            publisher_run("1.5.0-rc.29", "90-1", "2026-11-11T10:00:00Z")]))
        self.assertEqual(kind, "published")
        self.assertIn("request_id=90-1", reason)

    def test_only_this_versions_requests_from_the_release_app_count(self):
        self.assertIsNone(self.hold(HoldApi(publisher_runs=[
            publisher_run("1.4.27", "95-1", "2026-11-11T10:00:00Z", conclusion=None, status="waiting"),
            publisher_run("1.5.0-rc.2", "96-1", "2026-11-11T10:00:00Z"),
            publisher_run("1.5.0-rc.29", "90-1", "2026-11-11T10:00:00Z", actor="someone")])))

    def test_a_draft_older_than_the_queue_scan_evidence_is_held(self):
        self.assertIsNone(self.hold(HoldApi(), created="2026-11-10T18:00:00Z"))
        for retry in (False, True):
            with self.subTest(retry=retry):
                kind, _ = self.hold(HoldApi(), created="2026-11-10T17:59:59Z", retry=retry)
                self.assertEqual(kind, "expired")

    def test_a_scan_rejection_of_the_same_bytes_holds_the_draft(self):
        api = HoldApi(held_artifacts=[held(77, "2026-11-11T12:00:00Z")],
                      runs={77: source_run(77, html_url=f"https://github.com/{REPO}/actions/runs/77")})
        kind, reason = self.hold(api)
        self.assertEqual(kind, "rejected")
        self.assertIn(f"https://github.com/{REPO}/actions/runs/77", reason)
        self.assertIn((f"repos/{REPO}/actions/artifacts?name={HELD}&per_page=100", None), api.tokens)

    def test_retry_scans_the_held_bytes_again(self):
        api = HoldApi(held_artifacts=[held(77, "2026-11-11T12:00:00Z")], runs={77: source_run(77)})
        self.assertIsNone(self.hold(api, retry=True))

    def test_a_request_sent_after_the_rejection_lifts_the_hold(self):
        # A retry passed the scan and handed off; that request later failed.
        api = HoldApi(held_artifacts=[held(77, "2026-11-11T12:00:00Z")], runs={77: source_run(77)},
                      publisher_runs=[publisher_run("1.5.0-rc.29", "80-1", "2026-11-11T13:00:00Z",
                                                    conclusion="failure")])
        self.assertIsNone(self.hold(api))

    def test_only_this_branchs_release_runs_can_hold(self):
        # Anything in the repository can upload an artifact by that name.
        for artifact, run in (
            (held(77, "2026-11-11T12:00:00Z", expired=True), source_run(77)),
            (held(77, "2026-11-11T12:00:00Z", branch="release/1.4"), source_run(77, head_branch="release/1.4")),
            (held(77, "2026-11-11T12:00:00Z"), source_run(77, path=".github/workflows/on-pull-requests.yml")),
            (held(77, "2026-11-11T12:00:00Z"), source_run(77, event="pull_request")),
            (held(77, "2026-11-11T12:00:00Z"), source_run(77, head_branch="release/1.4")),
            (held(77, "2026-11-11T12:00:00Z"), source_run(77, repository={"full_name": "someone/archestra"})),
        ):
            with self.subTest(artifact=artifact, run=run):
                self.assertIsNone(self.hold(HoldApi(held_artifacts=[artifact], runs={77: run})))

    def test_an_unreadable_publisher_warns_and_still_checks_the_holds(self):
        api = HoldApi(held_artifacts=[held(77, "2026-11-11T12:00:00Z")], runs={77: source_run(77)},
                      publisher_error=FINALIZE.subprocess.CalledProcessError(1, "gh"))
        kind, _ = self.hold(api)
        self.assertEqual(kind, "rejected")
        self.assertEqual(len(self.warnings), 1)

    def test_malformed_inputs_check_nothing(self):
        api = HoldApi()
        for version, sha in (("latest", SHA), ("1.5.0-rc.29", "main"), ("1.5.0-rc.29", SHA[:12])):
            with self.subTest(version=version, sha=sha), self.assertRaises(ValueError):
                FINALIZE.recovery_hold(REPO, "main", version, sha, "2026-11-11T09:00:00Z", PUBLISHER, "t",
                                       request=api, now=NOW)
        self.assertEqual(api.tokens, [])


class RecordHoldTests(unittest.TestCase):
    def record(self, names, attempt=2):
        api = HoldApi(run_artifacts=[{"name": name} for name in names])
        return FINALIZE.record_hold(REPO, 90, attempt, "1.5.0-rc.29", SHA, request=api)

    def test_holds_only_for_this_attempts_scan_findings(self):
        hold = self.record(["release-scan-findings-mcp-server-base-2", "release-scan-findings-agent-codex-2",
                            "release-scan-findings-platform-1", "release-scan-findings-p4-shim-12",
                            "release-image-platform-2", "release-candidate-selection-2"])
        self.assertEqual(hold, {"version": "1.5.0-rc.29", "release_sha": SHA, "run_id": 90, "run_attempt": 2,
                                "images": ["agent-codex", "mcp-server-base"]})
        self.assertEqual(FINALIZE.held_artifact("1.5.0-rc.29", SHA), HELD)

    def test_other_failures_leave_later_pushes_to_recover(self):
        self.assertIsNone(self.record(["release-image-platform-2", "release-scan-findings-platform-1"]))

    def test_reads_every_page_of_the_runs_artifacts(self):
        names = [f"release-candidate-{index}-2" for index in range(150)] + ["release-scan-findings-platform-2"]
        self.assertEqual(self.record(names)["images"], ["platform"])


class HoldWorkflowTests(unittest.TestCase):
    """The workflows feed the hold the names and results record_hold reads."""

    ROOT = Path(__file__).resolve().parents[2]

    def test_every_release_image_build_feeds_the_hold(self):
        release = (self.ROOT / ".github/workflows/release-please.yml").read_text()
        hold = release.split("  hold-rejected-release:\n", 1)[1].split("\n  publish-platform-helm-chart:", 1)[0]
        builds = re.findall(r"^  (build-and-push-[\w-]+):$", release, re.M)
        self.assertEqual(len(builds), 5)
        for job in builds:
            self.assertIn(f"      - {job}\n", hold)
        self.assertIn("always()", hold)
        self.assertIn("contains(needs.*.result, 'failure')", hold)
        self.assertIn("release-finalize.py record-hold", hold)
        resolve = release.split("      - name: Resolve release to publish or recover\n", 1)[1].split("      - name:", 1)[0]
        self.assertIn("release-finalize.py recovery-hold", resolve)
        self.assertIn("RETRY_HELD: ${{ inputs.retry-held-release }}", resolve)

    def test_the_scan_findings_artifact_is_the_one_record_hold_reads(self):
        build = (self.ROOT / ".github/workflows/build-native-multi-arch-image.yml").read_text()
        name = re.search(r"name: (release-scan-findings-\$\{\{ inputs.image_name \}\}-\$\{\{ github.run_attempt \}\})",
                         build).group(1)
        rendered = name.replace("${{ inputs.image_name }}", "mcp-server-base").replace("${{ github.run_attempt }}", "3")
        api = HoldApi(run_artifacts=[{"name": rendered}])
        self.assertEqual(FINALIZE.record_hold(REPO, 90, 3, "1.5.0-rc.29", SHA, request=api)["images"],
                         ["mcp-server-base"])
        self.assertEqual(build.count("findings-file: ${{ runner.temp }}/release-scan-findings"), 2)


if __name__ == "__main__":
    unittest.main()
