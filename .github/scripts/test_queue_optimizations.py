"""Exercise stale-run races, E2E classification, and the required result gate."""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cancel = load("cancel-obsolete-queue-runs")
inputs = load("e2e-test-inputs")
SHA = "a" * 40
RUN = dict(id=12, event="merge_group", status="in_progress", head_sha=SHA,
           head_branch="gh-readonly-queue/main/pr-99-" + "b" * 40,
           created_at="2026-10-01T00:00:00Z", run_attempt=1)
CUTOFF = "2026-10-01T01:00:00Z"


class FakeAPI:
    def __init__(self, refs, current=None):
        self.refs = iter(refs)
        self.current = current or RUN
        self.cancelled = []

    def ref_sha(self, branch):
        return next(self.refs)

    def request(self, path, method="GET"):
        if method == "POST":
            self.cancelled.append(path)
        else:
            return self.current


class CancellationTests(unittest.TestCase):
    def test_current_group_is_never_cancelled(self):
        api = FakeAPI([SHA])
        self.assertFalse(cancel.cancel_obsolete(api, RUN, CUTOFF, False))
        self.assertEqual(api.cancelled, [])

    def test_deleted_and_replaced_refs_cancel_only_exact_run(self):
        for ref in (None, "c" * 40):
            api = FakeAPI([ref, ref])
            self.assertTrue(cancel.cancel_obsolete(api, RUN, CUTOFF, False))
            self.assertEqual(api.cancelled, ["/actions/runs/12/cancel"])

    def test_recreated_current_ref_survives(self):
        api = FakeAPI([None, SHA])
        self.assertFalse(cancel.cancel_obsolete(api, RUN, CUTOFF, False))
        self.assertEqual(api.cancelled, [])

    def test_rerun_completed_or_changed_identity_survives(self):
        for patch in ({"run_attempt": 2}, {"status": "completed"}, {"head_sha": "d" * 40},
                      {"created_at": CUTOFF}):
            api = FakeAPI([None], {**RUN, **patch})
            self.assertFalse(cancel.cancel_obsolete(api, RUN, CUTOFF, False))
            self.assertEqual(api.cancelled, [])

    def test_scope_and_cutoff(self):
        for patch in ({"event": "pull_request"}, {"head_branch": "main"},
                      {"head_branch": "gh-readonly-queue/main/not-a-queue-entry"},
                      {"created_at": CUTOFF}):
            api = FakeAPI([])
            self.assertFalse(cancel.cancel_obsolete(api, {**RUN, **patch}, CUTOFF, False))

    def test_dry_run_only_reports(self):
        api = FakeAPI([None, None])
        self.assertTrue(cancel.cancel_obsolete(api, RUN, CUTOFF, True))
        self.assertEqual(api.cancelled, [])

    def test_api_error_never_becomes_missing_ref(self):
        class BrokenAPI(FakeAPI):
            def ref_sha(self, branch):
                raise urllib.error.HTTPError("", 403, "Forbidden", {}, None)
        api = BrokenAPI([])
        with self.assertRaises(urllib.error.HTTPError) as raised:
            cancel.cancel_obsolete(api, RUN, CUTOFF, False)
        raised.exception.close()
        self.assertEqual(api.cancelled, [])


class InputTests(unittest.TestCase):
    def test_independent_changes_skip(self):
        self.assertFalse(inputs.run_e2e(["docs/pages/setup.md", "README.md", "ai-labs/Cargo.lock",
                                          "mcp-catalog/a.json", ".github/workflows/pr-title-linter.yml"]))

    def test_diff_handles_renames_deletions_and_invalid_base(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=directory, stderr=subprocess.DEVNULL).decode().strip()
            git("init", "-q")
            git("config", "user.name", "CI test")
            git("config", "user.email", "test@example.invalid")
            root = Path(directory)
            (root / "platform").mkdir()
            (root / "platform/input.txt").write_text("runtime")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            (root / "docs").mkdir()
            (root / "platform/input.txt").rename(root / "docs/moved.txt")
            git("add", "-A")
            git("commit", "-qm", "move")
            script = ROOT / ".github/scripts/e2e-test-inputs.py"
            result = subprocess.run(["python3", str(script), base, "HEAD"], cwd=directory, capture_output=True)
            self.assertEqual(result.stdout.strip(), b"true")
            result = subprocess.run(["python3", str(script), "missing", "HEAD"], cwd=directory, capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_platform_shared_and_unknown_changes_run(self):
        for path in ("platform/README.md", "platform/backend/src/app.ts", ".github/actions/setup-env/action.yml",
                     ".github/scripts/helper.py", ".github/kind.yaml", ".github/values-ci.yaml",
                     ".github/workflows/platform-e2e-tests.yml", ".github/workflows/docs.yml",
                     "new-root-build-input.json", ".github/new-fixture.yaml", ".github/workflows/new-workflow.yml"):
            with self.subTest(path=path):
                self.assertTrue(inputs.run_e2e(["docs/index.md", path]))
        self.assertTrue(inputs.run_e2e([]))


class RequiredGateTests(unittest.TestCase):
    def gate(self, **patch):
        workflow = (ROOT / ".github/workflows/platform-e2e-tests.yml").read_text()
        script = workflow.split("      - name: Fail if any e2e job failed", 1)[1].split("        run: |\n", 1)[1]
        script = script.split("\n  # Merges", 1)[0]
        script = "\n".join(line[10:] for line in script.splitlines())
        env = {**os.environ, "INPUT_RESULT": "success", "RUN_E2E": "true", "BUILD_RESULT": "success",
               "K8S_RESULT": "success", "LITE_RESULT": "success", "QUICKSTART_RESULT": "success",
               "HIBERNATION_RESULT": "skipped", "RUN_HIBERNATION": "false", **patch}
        return subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], env=env, capture_output=True).returncode

    def test_full_run_rejects_any_missing_or_failed_leg(self):
        self.assertEqual(self.gate(), 0)
        for key in ("INPUT_RESULT", "BUILD_RESULT", "K8S_RESULT", "LITE_RESULT", "QUICKSTART_RESULT"):
            for value in ("skipped", "failure", "cancelled", ""):
                self.assertNotEqual(self.gate(**{key: value}), 0)

    def test_only_successful_classification_allows_intentional_skip(self):
        skip = dict(RUN_E2E="false", BUILD_RESULT="skipped", K8S_RESULT="skipped", LITE_RESULT="skipped",
                    QUICKSTART_RESULT="skipped", HIBERNATION_RESULT="skipped")
        self.assertEqual(self.gate(**skip), 0)
        self.assertNotEqual(self.gate(**{**skip, "INPUT_RESULT": "failure"}), 0)
        self.assertNotEqual(self.gate(**{**skip, "K8S_RESULT": "failure"}), 0)


if __name__ == "__main__":
    unittest.main()
