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
        self.write(
            "platform/.dockerignore",
            "e2e-tests\ntools/docs-screenshots\n**/*.test.ts\n**/*.test.tsx\n",
        )
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

    def test_archestra_cli_sources_stay_out_and_the_release_lock_stays_in(self):
        self.write("platform/archestra-cli/src/main.rs", "fn main() {}\n")
        self.write("platform/archestra-cli/Cargo.toml", "[package]\n")
        self.write("platform/archestra-cli/release.lock.json", "{}\n")
        with (self.repo / "platform/.dockerignore").open("a") as output:
            output.write("archestra-cli/*\n!archestra-cli/release.lock.json\n")
        self.commit()
        initial = self.image_hash("platform")
        for name in (
            "platform/archestra-cli/src/main.rs",
            "platform/archestra-cli/Cargo.toml",
            "platform/archestra-cli/build.rs",
            # The lock negation leaves the other exclusions in force.
            "platform/e2e-tests/example.ts",
            "platform/backend/app.test.ts",
        ):
            with self.subTest(path=name):
                self.write(name, "changed\n")
                self.commit()
                self.assertEqual(self.image_hash("platform"), initial)
        self.write("platform/archestra-cli/release.lock.json", '{"version": "0.2.0"}\n')
        self.commit()
        self.assertNotEqual(self.image_hash("platform"), initial)

    def test_archestra_cli_sources_stay_in_without_the_exclusion(self):
        self.write("platform/archestra-cli/src/main.rs", "fn main() {}\n")
        self.commit()
        initial = self.image_hash("platform")
        self.write("platform/archestra-cli/src/main.rs", "changed\n")
        self.commit()
        self.assertNotEqual(self.image_hash("platform"), initial)

    def test_any_other_negation_still_disables_every_exclusion(self):
        self.write("platform/archestra-cli/src/main.rs", "fn main() {}\n")
        for negation in ("!archestra-cli/src/main.rs", "!archestra-cli/release.lock.json ", "!e2e-tests/example.ts"):
            with self.subTest(negation=negation):
                self.write(
                    "platform/.dockerignore",
                    "e2e-tests\narchestra-cli/*\n!archestra-cli/release.lock.json\n" + negation + "\n",
                )
                self.commit()
                previous = self.image_hash("platform")
                for name in ("platform/archestra-cli/src/main.rs", "platform/e2e-tests/example.ts"):
                    self.write(name, negation + " changed\n")
                    self.commit()
                    current = self.image_hash("platform")
                    self.assertNotEqual(current, previous)
                    previous = current

    def test_platform_ignore_file_keeps_only_the_release_lock_of_archestra_cli(self):
        # The hash script matches these two lines literally. The later line
        # wins in Docker, so the negation has to follow the exclusion.
        root = Path(__file__).resolve().parents[2]
        patterns = (root / "platform/.dockerignore").read_text().splitlines()
        self.assertEqual([p for p in patterns if p.lstrip().startswith("!")], ["!archestra-cli/release.lock.json"])
        self.assertLess(patterns.index("archestra-cli/*"), patterns.index("!archestra-cli/release.lock.json"))
        self.assertFalse((root / "platform/Dockerfile.dockerignore").exists())

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
