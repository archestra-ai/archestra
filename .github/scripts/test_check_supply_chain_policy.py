#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "check_supply_chain_policy",
    Path(__file__).resolve().parent / "check-supply-chain-policy.py",
)
policy = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(policy)


class IterCandidateFilesTest(unittest.TestCase):
    def test_scans_both_yml_and_yaml_under_github(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            github = root / ".github"
            github.mkdir()
            (github / "workflow.yml").write_text("a: 1\n")
            (github / "values.yaml").write_text("b: 2\n")
            (github / "bench").mkdir()
            (github / "bench" / "job.yaml").write_text("c: 3\n")
            (root / "Dockerfile").write_text("FROM scratch\n")

            found = {p.relative_to(root).as_posix() for p in policy.iter_candidate_files(root)}

        self.assertIn(".github/workflow.yml", found)
        self.assertIn(".github/values.yaml", found)
        self.assertIn(".github/bench/job.yaml", found)
        self.assertIn("Dockerfile", found)


class IsPostOnlyWebhookTest(unittest.TestCase):
    def test_accepts_equivalent_curl_post_spellings(self) -> None:
        for line in (
            'curl -X POST "$HOOK_URL"',
            'curl -XPOST "$HOOK_URL"',
            'curl --request POST https://hooks.example.com/x',
            'curl --request=POST https://hooks.example.com/x',
            'curl --request post https://hooks.example.com/x',
        ):
            self.assertTrue(policy.is_post_only_webhook(line), line)

    def test_rejects_non_post_downloads(self) -> None:
        for line in (
            "curl -o tool.tgz https://example.com/tool.tgz",
            "curl -X GET https://example.com/data",
            "wget https://example.com/tool.tgz",
            'echo "POST is mentioned but no curl here"',
            "curl -X POSTER https://example.com/x",
            "curl -o tool.tgz https://example.com/tool.tgz # example: -X POST webhook",
        ):
            self.assertFalse(policy.is_post_only_webhook(line), line)


class LooksLikeRemoteDownloadTest(unittest.TestCase):
    def test_detects_single_line_downloads(self) -> None:
        self.assertTrue(
            policy.looks_like_remote_download("curl -o x https://example.com/x.tgz")
        )
        self.assertTrue(
            policy.looks_like_remote_download("wget https://example.com/x.tgz")
        )

    def test_ignores_lines_without_urls_or_tools(self) -> None:
        self.assertFalse(policy.looks_like_remote_download("curl --version"))
        self.assertFalse(
            policy.looks_like_remote_download("echo https://example.com/docs")
        )


if __name__ == "__main__":
    unittest.main()
