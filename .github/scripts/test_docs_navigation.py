import importlib.util
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("docs_navigation", Path(__file__).with_name("check-docs-navigation.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DocsNavigationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.docs = Path(self.temp.name)
        (self.docs / "pages").mkdir()
        (self.docs / "pages" / "overview.md").write_text("Overview")

    def write_manifest(self, value):
        (self.docs / "navigation.json").write_text(json.dumps(value))

    def test_complete_navigation(self):
        self.write_manifest({"Get Started": ["overview"]})
        self.assertEqual(module.validate_navigation(self.docs), [])

    def test_invalid_shapes(self):
        for value in [None, [], {"A": "overview"}, {"A": []}, {"": ["overview"]}, {"A": [42]}, {"A": ["../overview"]}]:
            with self.subTest(value=value):
                self.write_manifest(value)
                self.assertTrue(module.validate_navigation(self.docs))

    def test_duplicate_unknown_and_orphan(self):
        self.write_manifest({"A": ["missing", "missing"]})
        errors = "\n".join(module.validate_navigation(self.docs))
        self.assertIn("Duplicate", errors)
        self.assertIn("Unknown", errors)
        self.assertIn("Page missing", errors)

    def test_missing_or_malformed_manifest(self):
        self.assertTrue(module.validate_navigation(self.docs))
        (self.docs / "navigation.json").write_text("{")
        self.assertTrue(module.validate_navigation(self.docs))

    def test_empty_pages(self):
        self.write_manifest({})
        (self.docs / "pages" / "overview.md").unlink()
        self.assertTrue(module.validate_navigation(self.docs))

    def test_invalid_manifest_fails_the_cli_gate(self):
        self.write_manifest({"A": ["missing"]})
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("check-docs-navigation.py")), "--docs-dir", str(self.docs)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("Unknown navigation slug", result.stderr)
        self.assertNotIn("check passed", result.stdout)

    def test_actual_manifest(self):
        root = Path(__file__).resolve().parents[2]
        self.assertEqual(module.validate_navigation(root / "docs"), [])


if __name__ == "__main__":
    unittest.main()
