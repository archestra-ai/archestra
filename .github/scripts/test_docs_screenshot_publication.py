"""Exercise screenshot publication decisions against real Git histories."""

import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("should-commit-docs-screenshots.py")


class ScreenshotPublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test")
        self.commit("initial", ["README.md"])

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True)

    def commit(self, subject, files):
        for filename in files:
            path = self.root / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(subject)
        self.git("add", ".")
        self.git("commit", "-qm", subject)

    def decision(self, event="pull_request"):
        return subprocess.check_output(
            ["python3", str(SCRIPT), event], cwd=self.root, text=True
        ).strip()

    def test_image_only_capture_commit_is_validated_without_republishing(self):
        self.commit("docs: update screenshots", ["docs/assets/example.webp"])
        self.assertEqual(self.decision(), "false")

    def test_source_change_still_publishes_even_with_capture_subject(self):
        self.commit("docs: update screenshots", ["docs/assets/example.webp", "platform/app.ts"])
        self.assertEqual(self.decision(), "true")

    def test_normal_release_commit_publishes(self):
        self.commit("chore(main): release platform 1.4.0-rc.36", ["platform/package.json"])
        self.assertEqual(self.decision(), "true")

    def test_manual_capture_still_publishes(self):
        self.commit("docs: update screenshots", ["docs/assets/example.webp"])
        self.assertEqual(self.decision("workflow_dispatch"), "true")


if __name__ == "__main__":
    unittest.main()
