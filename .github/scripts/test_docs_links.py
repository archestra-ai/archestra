import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


links = load("check-docs-links")


class DocsFixture(unittest.TestCase):
    """A throwaway repo root; the checkers resolve docs/ relative to the working directory."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)
        links.page_anchors.cache_clear()

    def write(self, relative, text):
        path = self.root / "docs/pages" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def run_script(self, name, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPTS / f"{name}.py"), *args], capture_output=True, text=True, cwd=self.root
        )


class AnchorTest(DocsFixture):
    def test_github_slug_matches_the_website(self):
        counts = {}
        self.assertEqual(links.github_slug("Identity Provider JWT / JWKS", counts), "identity-provider-jwt--jwks")
        self.assertEqual(links.github_slug("Skills vs. Agents (Beta)", counts), "skills-vs-agents-beta")
        self.assertEqual(links.github_slug("list_skills", counts), "list_skills")
        self.assertEqual(links.github_slug("Input", counts), "input")
        self.assertEqual(links.github_slug("Input", counts), "input-1")

    def test_heading_markup_is_slugged_as_rendered_text(self):
        self.write("a/index.md", "## The `load_skill` [Tool](/docs/x) **now**\n")
        self.assertIn("the-load_skill-tool-now", links.page_anchors(Path("docs/pages/a/index.md")))

    def test_resolves_heading_html_id_and_skips_code_and_comments(self):
        self.write(
            "a/index.md",
            '## Real\n\n<a id="custom"></a>\n\n```md\n## In Code\n```\n\n<!--\n## In Comment\n-->\n',
        )
        anchors = links.page_anchors(Path("docs/pages/a/index.md"))
        self.assertTrue({"real", "custom"} <= anchors)
        self.assertFalse({"in-code", "in-comment"} & anchors)

    def test_reports_missing_anchors_across_pages_same_page_and_redirects(self):
        self.write("a/index.md", "## Here\n\n[ok](/docs/b#there) [bad](/docs/b#gone) [self](#here) [selfbad](#nope)\n")
        self.write("b.md", "## There\n")
        (self.root / "docs/redirects.json").write_text(
            json.dumps({"redirects": [
                {"source": "/docs/old", "destination": "/docs/b#there"},
                {"source": "/docs/older", "destination": "/docs/b#missing"},
            ]})
        )
        result = self.run_script("check-docs-links")
        self.assertEqual(result.returncode, 1)
        self.assertIn("-> /docs/b#gone", result.stderr)
        self.assertIn("-> #nope", result.stderr)
        self.assertIn("redirects.json: anchor not found on docs/pages/b.md -> /docs/b#missing", result.stderr)
        self.assertNotIn("#there", result.stderr)
        self.assertNotIn("#here", result.stderr)


class ToolLinkTest(DocsFixture):
    def setUp(self):
        super().setUp()
        self.write("reference/archestra-mcp-server.md", "#### list_skills\n\n#### read_file\n\nUse `list_skills`.\n")

    def test_flags_unlinked_tool_mentions_only(self):
        self.write(
            "a/index.md",
            "Call `list_skills` and `archestra__read_file`, not `other_thing`.\n"
            "Linked: [`list_skills`](/docs/reference/archestra-mcp-server#list_skills).\n"
            "## `list_skills`\n\n```\n`list_skills`\n```\n\n| `read_file` |\n",
        )
        result = self.run_script("check-docs-mcp-tool-links")
        self.assertEqual(result.returncode, 1)
        self.assertIn("a/index.md:1: link `list_skills`", result.stderr)
        self.assertIn("a/index.md:1: link `read_file`", result.stderr)
        self.assertIn("a/index.md:9: link `read_file`", result.stderr)
        self.assertNotIn("other_thing", result.stderr)
        self.assertNotIn(":2:", result.stderr)
        self.assertNotIn("archestra-mcp-server.md", result.stderr)
        self.assertEqual(result.stderr.count("\n- "), 3)

    def test_fix_links_mentions_and_keeps_the_written_name(self):
        self.write("a/index.md", "Call `archestra__read_file`.\n")
        self.assertEqual(self.run_script("check-docs-mcp-tool-links", "--fix").returncode, 0)
        self.assertEqual(
            (self.root / "docs/pages/a/index.md").read_text(),
            "Call [`archestra__read_file`](/docs/reference/archestra-mcp-server#read_file).\n",
        )
        self.assertEqual(self.run_script("check-docs-mcp-tool-links").returncode, 0)


class EnvVarLinkTest(DocsFixture):
    ENTRY = "/docs/reference/configuration#ARCHESTRA_FOO"

    def setUp(self):
        super().setUp()
        self.write(
            "reference/configuration.md",
            "- **`ARCHESTRA_FOO`** - Turns on foo.\n  - Required when: `ARCHESTRA_BAR=on`\n\n- **`ARCHESTRA_BAR`** - Bar.\n",
        )

    def test_flags_unlinked_and_mistargeted_mentions_only(self):
        self.write(
            "a/index.md",
            "---\ntitle: A\nbeta: \"Set `ARCHESTRA_FOO=true`.\"\ndescription: `ARCHESTRA_FOO`\n---\n"
            "Set `ARCHESTRA_FOO`, not `ARCHESTRA_UNKNOWN`.\n"
            f"Linked: [`ARCHESTRA_FOO`]({self.ENTRY}).\n"
            "Wrong: [`ARCHESTRA_FOO=1`](/docs/reference/configuration).\n"
            "Inside: [turn on `ARCHESTRA_FOO`](/docs/x).\n"
            "## `ARCHESTRA_FOO`\n\n```\n`ARCHESTRA_FOO`\n```\n",
        )
        result = self.run_script("check-docs-env-var-links")
        self.assertEqual(result.returncode, 1)
        self.assertIn("a/index.md:3: link `ARCHESTRA_FOO`", result.stderr)
        self.assertIn("a/index.md:6: link `ARCHESTRA_FOO`", result.stderr)
        self.assertIn("a/index.md:8: link `ARCHESTRA_FOO`", result.stderr)
        self.assertIn("configuration.md:2: link `ARCHESTRA_BAR`", result.stderr)
        self.assertNotIn("UNKNOWN", result.stderr)
        self.assertEqual(result.stderr.count("\n- "), 4)

    def test_fix_links_to_the_exact_entry_and_keeps_the_value(self):
        self.write("a/index.md", "Set `ARCHESTRA_FOO=true` or [`ARCHESTRA_BAR`](/docs/reference/configuration).\n")
        self.assertEqual(self.run_script("check-docs-env-var-links", "--fix").returncode, 0)
        self.assertEqual(
            (self.root / "docs/pages/a/index.md").read_text(),
            f"Set [`ARCHESTRA_FOO=true`]({self.ENTRY}) or "
            "[`ARCHESTRA_BAR`](/docs/reference/configuration#ARCHESTRA_BAR).\n",
        )
        self.assertEqual(self.run_script("check-docs-env-var-links").returncode, 0)

    def test_entries_are_link_targets(self):
        self.write("a/index.md", f"See [`ARCHESTRA_FOO`]({self.ENTRY}) and [x](/docs/reference/configuration#ARCHESTRA_NOPE).\n")
        result = self.run_script("check-docs-links")
        self.assertEqual(result.returncode, 1)
        self.assertIn("#ARCHESTRA_NOPE", result.stderr)
        self.assertNotIn("#ARCHESTRA_FOO", result.stderr)


class ActualDocsTest(unittest.TestCase):
    def test_actual_docs_pass_both_checks(self):
        root = SCRIPTS.parents[1]
        for name in ("check-docs-links", "check-docs-mcp-tool-links", "check-docs-env-var-links"):
            result = subprocess.run([sys.executable, str(SCRIPTS / f"{name}.py")], capture_output=True, text=True, cwd=root)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
