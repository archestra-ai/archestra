"""Exercise conservative E2E classification against independent and runtime changes."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("e2e_inputs", Path(__file__).with_name("e2e-test-inputs.py"))
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)


class InputTests(unittest.TestCase):
    def test_independent_changes_skip(self):
        self.assertFalse(inputs.run_e2e(["docs/pages/setup.md", "README.md", "ai-labs/Cargo.lock",
                                          ".github/workflows/pr-title-linter.yml"]))

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

    def test_catalog_rename_and_deletion_run(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=directory, stderr=subprocess.DEVNULL).decode().strip()
            git("init", "-q")
            git("config", "user.name", "CI test")
            git("config", "user.email", "test@example.invalid")
            root = Path(directory)
            catalog = root / "mcp-catalog/data/mcp-evaluations"
            catalog.mkdir(parents=True)
            (catalog / "githubcopilot__remote-mcp.json").write_text('{}')
            (catalog / "slack__remote-mcp.json").write_text('{}')
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            (root / "docs").mkdir()
            (catalog / "githubcopilot__remote-mcp.json").rename(root / "docs/moved.json")
            (catalog / "slack__remote-mcp.json").unlink()
            git("add", "-A")
            git("commit", "-qm", "rename and delete catalog inputs")
            script = ROOT / ".github/scripts/e2e-test-inputs.py"
            result = subprocess.run(["python3", str(script), base, "HEAD"], cwd=directory, capture_output=True, check=True)
            self.assertEqual(result.stdout.strip(), b"true")

    def test_platform_shared_and_unknown_changes_run(self):
        for path in ("mcp-catalog/data/mcp-evaluations/githubcopilot__remote-mcp.json",
                     "mcp-catalog/data/mcp-evaluations/slack__remote-mcp.json", "mcp-catalog/new-input.json",
                     "platform/README.md", "platform/backend/src/app.ts", ".github/actions/setup-env/action.yml",
                     ".github/scripts/helper.py", ".github/kind.yaml", ".github/values-ci.yaml",
                     ".github/workflows/platform-e2e-tests.yml", ".github/workflows/docs.yml",
                     "new-root-build-input.json", ".github/new-fixture.yaml", ".github/workflows/new-workflow.yml"):
            with self.subTest(path=path):
                self.assertTrue(inputs.run_e2e(["docs/index.md", path]))
        self.assertTrue(inputs.run_e2e([]))


if __name__ == "__main__":
    unittest.main()
