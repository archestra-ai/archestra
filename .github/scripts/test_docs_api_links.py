import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent

SPEC = {
    "paths": {
        "/api/statistics/users": {"get": {"operationId": "getUserStatistics", "tags": ["Statistics"]}},
        "/api/knowledge-files/{fileId}/content": {"put": {"operationId": "upsertKnowledgeFile", "tags": ["Knowledge Files"]}},
        "/api/resource-permissions/{resource}/{scope}": {"get": {"operationId": "getResourcePermissions", "tags": ["Permissions"]}},
        "/api/untagged": {"get": {"tags": ["Misc"]}},
    }
}


class ApiLinkTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / "docs/pages").mkdir(parents=True)
        (self.root / "docs/openapi.json").write_text(json.dumps(SPEC))
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)

    def write(self, text):
        page = self.root / "docs/pages/page.md"
        page.write_text(text)
        return page

    def run_check(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "check-docs-api-links.py"), *args], capture_output=True, text=True, cwd=self.root
        )

    def test_fix_links_mentions_with_any_parameter_spelling(self):
        page = self.write(
            "Call `GET /api/statistics/users`, `PUT /api/knowledge-files/:fileId/content`, "
            "and `GET /api/resource-permissions/mcpRegistry/<catalog-id>`.\n"
        )
        self.assertEqual(self.run_check().returncode, 1)
        self.assertEqual(self.run_check("--fix").returncode, 0)
        text = page.read_text()
        self.assertIn("(/docs/reference/api#/Statistics/getUserStatistics)", text)
        self.assertIn("(/docs/reference/api#/Knowledge%20Files/upsertKnowledgeFile)", text)
        self.assertIn("(/docs/reference/api#/Permissions/getResourcePermissions)", text)
        self.assertEqual(self.run_check().returncode, 0)

    def test_reports_unknown_routes_and_operations_without_an_id(self):
        self.write("`GET /api/nope` and `GET /api/untagged`\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("`GET /api/nope` is not a documented API operation", result.stderr)
        self.assertIn("`GET /api/untagged` is not a documented API operation", result.stderr)

    def test_reports_deep_links_to_missing_operations(self):
        self.write("[x](/docs/reference/api#/Statistics/getGone)\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("no API operation for /docs/reference/api#/Statistics/getGone", result.stderr)

    def test_skips_code_blocks_headings_and_comments(self):
        self.write("```bash\n`GET /api/nope`\n```\n\n## `GET /api/nope`\n\n<!-- `GET /api/nope` -->\n")
        self.assertEqual(self.run_check().returncode, 0)


if __name__ == "__main__":
    unittest.main()
