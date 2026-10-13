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


def page(title="Page", order=1, description="About it"):
    return f"---\ntitle: {title}\ndescription: {description}\norder: {order}\n---\n\nBody\n"


class DocsTreeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.docs = Path(self.temp.name)
        self.write("get-started/index.md", page("Get Started", 1))
        self.write("get-started/quickstart.md", page("Quickstart", 1))
        self.write("get-started/connect/index.md", page("Connect", 2))
        self.write("get-started/connect/reference.md", page("Reference", 1))

    def write(self, relative, text):
        path = self.docs / "pages" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def errors(self):
        return "\n".join(module.validate_tree(self.docs))

    def test_valid_tree(self):
        self.assertEqual(self.errors(), "")

    def test_root_page_and_folder_without_index(self):
        self.write("stray.md", page())
        self.write("workspace/chat.md", page())
        errors = self.errors()
        self.assertIn("section folder: stray.md", errors)
        self.assertIn("no index.md: workspace", errors)

    def test_docs_home_is_the_only_root_page(self):
        self.write("index.md", page("Docs", 0))
        self.assertEqual(self.errors(), "")

    def test_depth_limit(self):
        for depth, folder in enumerate(["a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e"], start=1):
            self.write(f"{folder}/index.md", page(order=depth + 1))
        self.assertIn("at most 4 levels deep: a/b/c/d/e", self.errors())

    def test_frontmatter_and_naming(self):
        self.write("get-started/Bad_Name.md", page(order=3))
        self.write("get-started/no-order.md", "---\ntitle: X\ndescription: Y\n---\n")
        self.write("get-started/no-description.md", "---\ntitle: X\norder: 4\n---\n")
        errors = self.errors()
        self.assertIn("lowercase words and hyphens: get-started/Bad_Name.md", errors)
        self.assertIn("numeric `order` frontmatter: get-started/no-order.md", errors)
        self.assertIn("`description` frontmatter: get-started/no-description.md", errors)

    def test_sibling_order_clash_counts_folder_index_with_its_siblings(self):
        self.write("get-started/migrate.md", page(order=2))
        self.assertIn("share order 2", self.errors())

    def test_redirects(self):
        (self.docs / "redirects.json").write_text(json.dumps({"redirects": [
            {"source": "/docs/old-quickstart", "destination": "/docs/get-started/quickstart#install"},
            {"source": "/docs/get-started/connect", "destination": "/docs/get-started"},
            {"source": "/docs/old", "destination": "/docs/nowhere"},
        ]}))
        errors = self.errors()
        self.assertIn("shadows a page: /docs/get-started/connect", errors)
        self.assertIn("no page: /docs/old -> /docs/nowhere", errors)
        self.assertNotIn("old-quickstart", errors)

    def test_invalid_tree_fails_the_cli_gate(self):
        self.write("stray.md", page())
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("check-docs-navigation.py")), "--docs-dir", str(self.docs)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("check passed", result.stdout)

    def test_actual_docs(self):
        root = Path(__file__).resolve().parents[2]
        self.assertEqual(module.validate_tree(root / "docs"), [])


if __name__ == "__main__":
    unittest.main()
