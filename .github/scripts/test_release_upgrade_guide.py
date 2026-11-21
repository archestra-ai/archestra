import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent / "check-release-upgrade-guide.py"


class ReleaseUpgradeGuideTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def release(self, version, guide=None):
        manifest = self.root / ".github/release-please/.release-please-manifest.json"
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({"platform": version}))
        if guide:
            page = self.root / "docs/pages/admin" / guide
            page.parent.mkdir(parents=True, exist_ok=True)
            page.write_text("---\ntitle: Upgrade\n---\n")
        return subprocess.run(
            [sys.executable, str(SCRIPT)], cwd=self.root, capture_output=True, text=True, env=os.environ.copy()
        )

    def test_new_stable_line_without_a_guide_fails(self):
        result = self.release("1.5.0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("upgrade-v<previous major>-<previous minor>-to-v1-5.md", result.stdout)

    def test_new_stable_line_with_its_guide_passes(self):
        self.assertEqual(self.release("1.5.0", "upgrade-v1-4-to-v1-5.md").returncode, 0)
        self.assertEqual(self.release("2.0.0", "upgrade-v1-9-to-v2-0.md").returncode, 0)

    def test_a_guide_for_another_line_does_not_count(self):
        self.assertEqual(self.release("1.5.0", "upgrade-v1-3-to-v1-4.md").returncode, 1)

    def test_patches_and_prereleases_pass(self):
        for version in ("1.5.1", "1.6.0-rc.3", "1.6.0-beta.1"):
            self.assertEqual(self.release(version).returncode, 0, version)


if __name__ == "__main__":
    unittest.main()
