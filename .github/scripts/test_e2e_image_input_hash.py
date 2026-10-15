"""Check image reuse against real committed context changes."""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("e2e-image-input-hash.sh")


class ImageInputHashTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "ci@example.test")
        self.git("config", "user.name", "CI")
        for name in (
            ".github/workflows/platform-e2e-tests.yml",
            ".github/actions/build-docker-image/action.yml",
            ".github/actions/setup-docker-builder/action.yml",
            "platform/Dockerfile",
            "platform/e2e-tests/example.ts",
            "platform/tools/docs-screenshots/src/example.ts",
            "platform/tools/biome-plugins/example.grit",
            "platform/docker_images/mcp_server/Dockerfile",
        ):
            self.write(name, "initial\n")
        destination = self.repo / ".github/scripts/e2e-image-input-hash.sh"
        destination.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, destination)
        self.commit()

    def test_capture_and_e2e_changes_do_not_invalidate_platform_image(self):
        initial = self.image_hash("platform")
        for name in (
            "platform/e2e-tests/example.ts",
            "platform/tools/docs-screenshots/src/example.ts",
            "platform/tools/docs-screenshots/src/new.ts",
        ):
            with self.subTest(path=name):
                self.write(name, "changed\n")
                self.commit()
                self.assertEqual(self.image_hash("platform"), initial)

    def test_other_nested_tools_and_runtime_sources_invalidate_platform_image(self):
        previous = self.image_hash("platform")
        for name in (
            "platform/tools/biome-plugins/example.grit",
            "platform/Dockerfile",
            ".github/actions/build-docker-image/action.yml",
        ):
            with self.subTest(path=name):
                self.write(name, "changed\n")
                self.commit()
                current = self.image_hash("platform")
                self.assertNotEqual(current, previous)
                previous = current

    def test_mcp_hash_tracks_moved_context_and_ignores_other_images(self):
        initial = self.image_hash("mcp-base")
        self.write("platform/docker_images/agent/Dockerfile", "FROM scratch\n")
        self.commit()
        self.assertEqual(self.image_hash("mcp-base"), initial)
        self.write("platform/docker_images/mcp_server/Dockerfile", "FROM scratch\n")
        self.commit()
        self.assertNotEqual(self.image_hash("mcp-base"), initial)

    def image_hash(self, kind):
        return subprocess.check_output(
            ["bash", str(SCRIPT.resolve()), kind], cwd=self.repo, text=True
        ).strip()

    def write(self, name, content):
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "context change")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True)


if __name__ == "__main__":
    unittest.main()
