"""Exercise the workflow's detector against real shallow Git checkouts."""

import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest


WORKFLOW = Path(__file__).parents[1] / "workflows/on-pull-requests-dagger-sdk.yml"


def detector_script():
    section = WORKFLOW.read_text().split("      - name: Detect Dagger-related changes\n", 1)[1]
    lines = section.split("        run: |\n", 1)[1].splitlines()
    script = []
    for line in lines:
        if line and not line.startswith("          "):
            break
        script.append(line[10:])
    return "\n".join(script)


class DaggerCheckoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.git(self.source, "init", "-qb", "main")
        self.git(self.source, "config", "user.name", "CI test")
        self.git(self.source, "config", "user.email", "test@example.invalid")
        (self.source / "platform").mkdir()
        (self.source / "platform/Dockerfile").write_text("FROM scratch\n")
        self.base = self.commit("base")
        self.git(self.source, "tag", "unneeded-tag")
        (self.source / "README.md").write_text("middle\n")
        self.middle = self.commit("middle")

    def git(self, directory, *args, check=True):
        return subprocess.run(
            ["git", *args], cwd=directory, capture_output=True, text=True, check=check,
        )

    def commit(self, message):
        self.git(self.source, "add", ".")
        self.git(self.source, "commit", "-qm", message)
        return self.git(self.source, "rev-parse", "HEAD").stdout.strip()

    def checkout(self, runtime_change):
        path = self.source / ("platform/Dockerfile" if runtime_change else "README.md")
        path.write_text(path.read_text() + "# change\n")
        self.commit("head")
        self.clone = self.root / "checkout"
        depth = re.search(r"fetch-depth: (\d+)", WORKFLOW.read_text()).group(1)
        depth_args = [] if depth == "0" else [f"--depth={depth}"]
        self.git(self.root, "clone", *depth_args, "--branch=main", self.source.as_uri(), str(self.clone))
        self.assertNotEqual(self.git(self.clone, "cat-file", "-e", self.base, check=False).returncode, 0)

    def detect(self, base=None):
        output = self.root / "output"
        result = subprocess.run(
            ["bash", "-e", "-c", detector_script()], cwd=self.clone / "platform",
            env=os.environ | {"BASE_SHA": base or self.base, "GH_TOKEN": "test-token",
                              "GITHUB_OUTPUT": str(output)},
            capture_output=True, text=True,
        )
        return result, output.read_text() if output.exists() else ""

    def test_fetches_only_missing_base_and_detects_runtime_change(self):
        self.checkout(True)
        result, output = self.detect()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "run=true\n")
        self.assertEqual(self.git(self.clone, "rev-parse", "--is-shallow-repository").stdout.strip(), "true")
        self.assertNotEqual(self.git(self.clone, "cat-file", "-e", self.middle, check=False).returncode, 0)
        self.assertEqual(self.git(self.clone, "tag", "--list").stdout, "")
        self.assertNotEqual(self.git(self.clone, "config", "--local", "--get-regexp", "credential", check=False).returncode, 0)
        self.assertNotIn("test-token", result.stdout + result.stderr)

    def test_unrelated_changes_still_skip(self):
        self.checkout(False)
        result, output = self.detect()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "run=false\n")

    def test_available_base_does_not_need_remote(self):
        self.checkout(True)
        self.git(self.clone, "fetch", "--no-tags", "--depth=1", "origin", self.base)
        self.git(self.clone, "remote", "set-url", "origin", str(self.root / "missing-origin"))
        result, output = self.detect()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "run=true\n")

    def test_missing_base_fails_instead_of_skipping(self):
        self.checkout(False)
        result, output = self.detect("a" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, "")

    def test_invalid_base_fails_instead_of_skipping(self):
        self.checkout(False)
        result, output = self.detect("--all")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, "")


if __name__ == "__main__":
    unittest.main()
