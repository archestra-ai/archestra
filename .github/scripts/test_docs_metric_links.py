import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent

METRICS = """# Metrics

| Metric | Labels | Measures |
| --- | --- | --- |
| `rag_queries_total`, `rag_query_duration_seconds` | `search_type` | Searches |
| <span id="llm_cost_total"></span>`llm_cost_total` | `billing_mode` | Cost |

| Label | Values |
| --- | --- |
| `provider` | The provider |
"""


class MetricLinkTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        reference = self.root / "docs/pages/admin/observability/metrics/knowledge-base.md"
        reference.parent.mkdir(parents=True)
        reference.write_text(METRICS.replace('| <span id="llm_cost_total"></span>`llm_cost_total` | `billing_mode` | Cost |\n', ''))
        (reference.parent / "index.md").write_text("# Metrics\n")
        self.llm_reference = reference.parent / "llm.md"
        self.llm_reference.write_text('# LLM\n\n| Metric | Type |\n| --- | --- |\n| <span id="llm_cost_total"></span>`llm_cost_total` | Counter |\n')
        self.reference = reference
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)

    def write(self, text):
        page = self.root / "docs/pages/page.md"
        page.write_text(text)
        return page

    def run_check(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "check-docs-metric-links.py"), *args], capture_output=True, text=True, cwd=self.root
        )

    def test_fix_anchors_every_metric_in_a_row_and_skips_label_tables(self):
        self.write("Nothing here.\n")
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn('add <span id="rag_query_duration_seconds"></span>', result.stderr)
        self.assertNotIn("provider", result.stderr)
        self.assertEqual(self.run_check("--fix").returncode, 0)
        text = self.reference.read_text()
        self.assertIn('<span id="rag_queries_total"></span>`rag_queries_total`', text)
        self.assertIn('<span id="rag_query_duration_seconds"></span>`rag_query_duration_seconds`', text)
        self.assertEqual(self.llm_reference.read_text().count('<span id="llm_cost_total">'), 1)
        self.assertNotIn('<span id="provider">', text)

    def test_fix_links_mentions_and_retargets_wrong_links(self):
        self.run_check("--fix")
        page = self.write(
            "Watch `rag_queries_total` and [`llm_cost_total`](/docs/admin/observability/metrics#llm-metrics).\n"
        )
        self.assertEqual(self.run_check().returncode, 1)
        self.assertEqual(self.run_check("--fix").returncode, 0)
        text = page.read_text()
        self.assertIn("[`rag_queries_total`](/docs/admin/observability/metrics/knowledge-base#rag_queries_total)", text)
        self.assertIn("[`llm_cost_total`](/docs/admin/observability/metrics/llm#llm_cost_total)", text)
        self.assertEqual(self.run_check().returncode, 0)

    def test_ignores_code_blocks_headings_and_unknown_names(self):
        self.run_check("--fix")
        self.write("## `rag_queries_total`\n\n```promql\nrate(rag_queries_total[5m])\n```\n\nThe `search_type` label.\n")
        self.assertEqual(self.run_check().returncode, 0)

    def test_reference_prose_links_other_families_but_not_its_own_metrics(self):
        self.run_check("--fix")
        self.reference.write_text(self.reference.read_text() + "\nSee `rag_queries_total` and `llm_cost_total`.\n")
        self.assertEqual(self.run_check("--fix").returncode, 0)
        self.assertIn("See `rag_queries_total` and [`llm_cost_total`](/docs/admin/observability/metrics/llm#llm_cost_total).", self.reference.read_text())
        self.assertEqual(self.run_check().returncode, 0)

    def test_metric_moves_retarget_existing_links(self):
        self.run_check("--fix")
        page = self.write("[`rag_queries_total`](/docs/admin/observability/metrics/knowledge-base#rag_queries_total)\n")
        self.reference.rename(self.reference.with_name("retrieval.md"))
        self.assertEqual(self.run_check().returncode, 1)
        self.assertEqual(self.run_check("--fix").returncode, 0)
        self.assertIn("/metrics/retrieval#rag_queries_total", page.read_text())

    def test_duplicate_metric_definitions_fail(self):
        self.run_check("--fix")
        self.reference.with_name("duplicate.md").write_text(self.reference.read_text())
        result = self.run_check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("already documented", result.stderr)


if __name__ == "__main__":
    unittest.main()
