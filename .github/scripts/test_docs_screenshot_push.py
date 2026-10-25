"""Exercise publication against real Git remotes, including queue admission races."""

import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("push-docs-screenshots.py")


class ScreenshotPushTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.remote = self.root / "remote.git"
        self.work = self.root / "work"
        self.git("init", "--bare", "-q", str(self.remote), cwd=self.root)
        self.git("init", "-q", str(self.work), cwd=self.root)
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test")
        self.git("remote", "add", "origin", str(self.remote))
        (self.work / "image.webp").write_text("captured image")
        self.git("add", ".")
        self.git("commit", "-qm", "docs: update screenshots")

    def git(self, *args, cwd=None):
        return subprocess.check_output(
            ["git", *args], cwd=cwd or self.work, text=True,
            stderr=subprocess.PIPE,
        ).strip()

    def reject(self, message):
        hook = self.remote / "hooks" / "pre-receive"
        hook.write_text(f"#!/bin/sh\ncat >&2 <<'MESSAGE'\n{message}\nMESSAGE\nexit 1\n")
        hook.chmod(0o755)

    def push(self):
        return subprocess.run(
            ["python3", str(SCRIPT), "release-please--test"],
            cwd=self.work, capture_output=True, text=True,
            env={**os.environ, "GITHUB_OUTPUT": str(self.root / "outputs")},
        )

    def test_success_publishes_the_capture(self):
        result = self.push()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.git("rev-parse", "refs/heads/release-please--test", cwd=self.remote),
            self.git("rev-parse", "HEAD"),
        )

    def test_queue_admission_race_retains_remote_head_without_retry(self):
        self.assertEqual(self.push().returncode, 0)
        previous = self.git("rev-parse", "HEAD")
        self.git("commit", "--allow-empty", "-qm", "new capture")
        self.reject(
            "error: GH006: Protected branch update failed for refs/heads/release-please--test.\n"
            "  A pull request for this branch has been added to a merge queue. Branches that\n"
            "  are queued for merging cannot be updated. To modify this branch, dequeue the\n"
            "  associated pull request."
        )
        result = self.push()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("retaining validated screenshot artifacts", result.stdout)
        self.assertEqual((self.root / "outputs").read_text(), "queued=true\n")
        self.assertEqual(
            self.git("rev-parse", "refs/heads/release-please--test", cwd=self.remote), previous,
        )

    def test_other_protection_and_permission_failures_remain_failures(self):
        for message in (
            "error: GH006: Protected branch update failed. Required status check is expected.",
            "Permission denied", "Repository not found",
        ):
            with self.subTest(message=message):
                self.reject(message)
                result = self.push()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertNotIn("retaining validated", result.stdout)

    def test_non_fast_forward_does_not_overwrite_a_concurrent_update(self):
        self.assertEqual(self.push().returncode, 0)
        self.git("commit", "--allow-empty", "-qm", "concurrent release update")
        self.assertEqual(self.push().returncode, 0)
        previous = self.git("rev-parse", "HEAD")
        self.git("checkout", "--detach", "HEAD^")
        self.git("commit", "--allow-empty", "-qm", "stale capture")
        result = self.push()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("non-fast-forward", result.stderr)
        self.assertEqual(
            self.git("rev-parse", "refs/heads/release-please--test", cwd=self.remote), previous,
        )


if __name__ == "__main__":
    unittest.main()
