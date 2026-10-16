"""Exercise preflight's revision guards and fail-fast behavior with real Git."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.platform = self.repo / "platform"
        scripts = self.platform / "scripts"
        scripts.mkdir(parents=True)
        shutil.copy(ROOT / "platform/scripts/preflight.mjs", scripts)
        self.git("init", "-q")
        self.git("config", "user.email", "ci@example.test")
        self.git("config", "user.name", "CI")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.head = self.git("rev-parse", "HEAD")
        self.marker = self.root / "calls"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        # pnpm is the process boundary: no package installation or real suites.
        pnpm = bin_dir / "pnpm"
        pnpm.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, subprocess, sys\n"
            "marker = pathlib.Path(os.environ['ARCHESTRA_TEST_PREFLIGHT_CALLS'])\n"
            "with marker.open('a') as out:\n"
            "    out.write(json.dumps({'args': sys.argv[1:], 'cwd': os.getcwd()}) + '\\n')\n"
            "call = len(marker.read_text().splitlines())\n"
            "if call == 1 and os.environ.get('ARCHESTRA_TEST_PREFLIGHT_CHANGE_HEAD'):\n"
            "    subprocess.run(['git', 'commit', '--allow-empty', '-qm', 'concurrent change'], check=True)\n"
            "if call == 1 and os.environ.get('ARCHESTRA_TEST_PREFLIGHT_DIRTY_DURING_CHECK'):\n"
            "    pathlib.Path('new-source.ts').write_text('changed during preflight')\n"
            "if str(call) == os.environ.get('ARCHESTRA_TEST_PREFLIGHT_FAIL_CALL'):\n"
            "    sys.exit(23)\n"
        )
        pnpm.chmod(0o755)
        self.env = os.environ | {
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "ARCHESTRA_TEST_PREFLIGHT_CALLS": str(self.marker),
        }

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, check=True,
            capture_output=True, text=True,
        ).stdout.strip()

    def run_preflight(self, *args, **env):
        return subprocess.run(
            ["node", str(self.platform / "scripts/preflight.mjs"), *args],
            # The command must resolve platform even when invoked elsewhere.
            cwd=self.root, env=self.env | env, text=True, capture_output=True,
        )

    def calls(self):
        if not self.marker.exists():
            return []
        return [json.loads(line) for line in self.marker.read_text().splitlines()]

    def test_clean_revision_runs_checks_from_platform_and_reports_its_sha(self):
        result = self.run_preflight(self.head)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Preflight passed for {self.head}", result.stdout)
        self.assertTrue(self.calls())
        self.assertTrue(all(c["cwd"] == str(self.platform.resolve()) for c in self.calls()))

    def test_failure_stops_later_checks_and_cannot_report_success(self):
        for stage in (1, 2, 3):
            with self.subTest(stage=stage):
                self.marker.unlink(missing_ok=True)
                result = self.run_preflight(ARCHESTRA_TEST_PREFLIGHT_FAIL_CALL=str(stage))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(self.calls()), stage)
                self.assertNotIn("Preflight passed", result.stdout)

    def test_wrong_revision_is_rejected_before_running_checks(self):
        result = self.run_preflight("0" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_tracked_staged_and_untracked_changes_block_preflight(self):
        source = self.platform / "scripts/preflight.mjs"
        original = source.read_text()
        for staged in (False, True):
            with self.subTest(staged=staged):
                source.write_text(original + "\n// local change\n")
                if staged:
                    self.git("add", ".")
                result = self.run_preflight()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.calls(), [])
                self.git("restore", "--staged", ".")
                source.write_text(original)
        (self.platform / "new-source.ts").write_text("untracked")
        self.assertNotEqual(self.run_preflight().returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_head_change_during_checks_invalidates_success(self):
        result = self.run_preflight(ARCHESTRA_TEST_PREFLIGHT_CHANGE_HEAD="true")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HEAD changed", result.stderr)
        self.assertNotIn("Preflight passed", result.stdout)

    def test_worktree_change_during_checks_invalidates_success(self):
        result = self.run_preflight(ARCHESTRA_TEST_PREFLIGHT_DIRTY_DURING_CHECK="true")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("clean checkout", result.stderr)
        self.assertNotIn("Preflight passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
