"""Exercise image identity and the lite harness against real Git trees."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).parent
ROOT = SCRIPTS.parent.parent
HASH_SCRIPT = ".github/scripts/e2e-image-input-hash.sh"
HARNESS = "platform/scripts/e2e-lite.sh"
RECIPES = (
    ".github/workflows/platform-e2e-tests.yml",
    ".github/actions/build-docker-image/action.yml",
    ".github/actions/setup-docker-builder/action.yml",
)


class ImageInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "ci@example.test")
        self.git("config", "user.name", "CI")
        for path in (HASH_SCRIPT, HARNESS):
            self.write(path, (ROOT / path).read_text())
        for path in RECIPES:
            self.write(path, "name: build\n")
        self.write("platform/.dockerignore", "e2e-tests\ndocs-screenshots\n**/*.test.ts\n**/*.test.tsx\n")
        self.write("platform/Dockerfile", "FROM scratch\nCOPY . /app\n")
        self.write("platform/backend/app.ts", "export const value = 1;\n")
        self.write("platform/mcp_server_docker_image/Dockerfile", "FROM scratch\n")
        self.commit()
        self.initial = self.digest()

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.root, capture_output=True, text=True, check=True
        ).stdout.strip()

    def write(self, path, content):
        destination = self.root / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def digest(self, kind="platform"):
        return subprocess.run(
            ["bash", HASH_SCRIPT, kind], cwd=self.root,
            capture_output=True, text=True, check=True,
        ).stdout.strip()

    def test_docker_excluded_test_changes_keep_the_image(self):
        for path in (
            "platform/backend/app.test.ts", "platform/frontend/app.test.tsx",
            "platform/e2e-tests/example.spec.ts", "platform/docs-screenshots/manifest.ts",
        ):
            self.write(path, "test input\n")
        self.commit()
        self.assertEqual(self.digest(), self.initial)

    def test_runtime_change_and_rename_invalidate_the_image(self):
        self.write("platform/backend/app.ts", "export const value = 2;\n")
        self.commit()
        changed = self.digest()
        self.assertNotEqual(changed, self.initial)
        self.git("mv", "platform/backend/app.ts", "platform/backend/renamed.ts")
        self.commit()
        self.assertNotEqual(self.digest(), changed)

    def test_each_build_recipe_invalidates_the_image(self):
        previous = self.initial
        for path in (*RECIPES, HASH_SCRIPT, "platform/.dockerignore"):
            with self.subTest(path=path):
                with (self.root / path).open("a") as output:
                    output.write("\n# updated recipe\n")
                self.commit()
                current = self.digest()
                self.assertNotEqual(current, previous)
                previous = current

    def test_ignore_negations_disable_test_exclusion(self):
        with (self.root / "platform/.dockerignore").open("a") as output:
            output.write("!backend/app.test.ts\n")
        self.commit()
        previous = self.digest()
        self.write("platform/backend/app.test.ts", "now in the image\n")
        self.commit()
        self.assertNotEqual(self.digest(), previous)

    def test_dockerfile_ignore_override_disables_test_exclusion(self):
        self.write("platform/Dockerfile.dockerignore", "node_modules\n")
        self.commit()
        previous = self.digest()
        self.write("platform/backend/app.test.ts", "included by override\n")
        self.commit()
        self.assertNotEqual(self.digest(), previous)

    def test_mcp_base_identity_does_not_change_with_platform_source(self):
        previous = self.digest("mcp-base")
        self.write("platform/backend/app.ts", "runtime change\n")
        self.commit()
        self.assertEqual(self.digest("mcp-base"), previous)

    def resolve(self, pull_fails=False, override=""):
        # Evaluate the real harness definitions, without dispatching a stack.
        # Docker is the process boundary; no daemon or running dev stack is used.
        source = (self.root / HARNESS).read_text().rsplit('\ncase "${1:-}" in\n', 1)[0]
        runner = self.root / "platform/scripts/resolve-test.sh"
        runner.write_text(source + "\nresolve_platform_image\n")
        bin_dir = Path(self.temp.name).parent / (self.root.name + "-bin")
        bin_dir.mkdir(exist_ok=True)
        self.addCleanup(shutil.rmtree, bin_dir)
        marker = bin_dir / "docker-calls"
        docker = bin_dir / "docker"
        docker.write_text(
            '#!/bin/bash\nprintf "%s\\n" "$*" >> "$DOCKER_CALLS"\n'
            'if [ "$1" = pull ] && [ "$PULL_FAILS" = true ]; then exit 1; fi\n'
        )
        docker.chmod(0o755)
        # Commit the driver so the clean-checkout path is exercised.
        self.git("add", "-f", "platform/scripts/resolve-test.sh")
        self.git("commit", "-qm", "resolver driver")
        result = subprocess.run(
            ["bash", str(runner)], cwd=self.root, text=True, capture_output=True,
            env=os.environ | {
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "DOCKER_CALLS": str(marker), "PULL_FAILS": str(pull_fails).lower(),
                "PLATFORM_IMAGE": override,
            },
            check=True,
        )
        return result.stdout.strip(), marker.read_text() if marker.exists() else ""

    def test_screenshot_harness_pulls_the_current_input_tag(self):
        image, calls = self.resolve()
        self.assertTrue(image.endswith(f":input-{self.digest()}-slim"), image)
        self.assertIn(f"pull --quiet {image}", calls)
        self.assertNotIn("build ", calls)

    def test_missing_image_builds_locally(self):
        image, calls = self.resolve(pull_fails=True)
        self.assertEqual(image, "archestra-platform:e2e-lite")
        self.assertIn("build -t archestra-platform:e2e-lite", calls)

    def test_local_build_recipe_changes_cannot_reuse_head_image(self):
        self.write(RECIPES[0], "name: local change\n")
        image, calls = self.resolve()
        self.assertEqual(image, "archestra-platform:e2e-lite")
        self.assertNotIn("pull ", calls)

    def test_explicit_image_override_does_not_pull_or_build(self):
        image, calls = self.resolve(override="example.invalid/custom:local")
        self.assertEqual(image, "example.invalid/custom:local")
        self.assertEqual(calls, "")


if __name__ == "__main__":
    unittest.main()
