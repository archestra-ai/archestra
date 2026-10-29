"""Exercise the required gate against failed, cancelled, and skipped captures."""

import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("check-docs-screenshot-result.py")


class ScreenshotResultTests(unittest.TestCase):
    def gate(self, event, result, validation_only="false"):
        with tempfile.TemporaryDirectory() as directory:
            summary = pathlib.Path(directory) / "summary"
            process = subprocess.run(
                ["python3", str(SCRIPT)],
                env={**os.environ, "EVENT_NAME": event, "CAPTURE_RESULT": result,
                     "VALIDATION_ONLY": validation_only, "GITHUB_STEP_SUMMARY": str(summary)},
                capture_output=True, text=True,
            )
            return process, summary.read_text() if summary.exists() else ""

    def test_queue_fails_closed_for_every_non_success_result(self):
        for result in ("failure", "cancelled", "skipped", "", "pending", "timed_out"):
            with self.subTest(result=result):
                process, summary = self.gate("merge_group", result)
                self.assertNotEqual(process.returncode, 0)
                self.assertEqual(summary, "")

    def test_queue_reports_capture_success(self):
        process, summary = self.gate("merge_group", "success")
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn("All docs screenshots captured", summary)

    def test_pr_explicitly_reports_deferred_execution(self):
        process, summary = self.gate("pull_request", "skipped")
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn("does not validate screenshots", summary)

    def test_manual_validation_cannot_skip_or_fail(self):
        for result in ("skipped", "failure", "cancelled"):
            with self.subTest(result=result):
                process, _ = self.gate("workflow_dispatch", result, "true")
                self.assertNotEqual(process.returncode, 0)
        process, _ = self.gate("workflow_dispatch", "success", "true")
        self.assertEqual(process.returncode, 0, process.stderr)

    def test_manual_publication_is_separate_from_validation(self):
        process, summary = self.gate("workflow_dispatch", "skipped")
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn("deferred", summary)

    def test_unknown_events_and_unexpected_execution_fail(self):
        for event, result in (("push", "success"), ("pull_request", "success"),
                              ("pull_request", "failure")):
            with self.subTest(event=event, result=result):
                process, _ = self.gate(event, result)
                self.assertNotEqual(process.returncode, 0)
