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


class FoldContinuationsTest(unittest.TestCase):
    def test_joins_backslash_continued_lines_keeping_first_line_number(self) -> None:
        folded = policy.fold_continuations(
            [
                "curl -fsSL \\",
                "  -o /tmp/tool.tgz \\",
                "  https://example.com/tool.tgz",
                "echo done",
            ]
        )
        self.assertEqual(
            folded,
            [
                (1, "curl -fsSL -o /tmp/tool.tgz https://example.com/tool.tgz"),
                (4, "echo done"),
            ],
        )

    def test_comment_lines_do_not_continue(self) -> None:
        folded = policy.fold_continuations(["# trailing backslash \\", "FROM scratch"])
        self.assertEqual(folded, [(1, "# trailing backslash \\"), (2, "FROM scratch")])

    def test_even_trailing_backslashes_are_literal_not_continuation(self) -> None:
        # `echo foo \\` in shell is an escaped literal backslash; the statement
        # ends there and the next line is an independent command.
        folded = policy.fold_continuations(["echo foo \\\\", "echo bar"])
        self.assertEqual(folded, [(1, "echo foo \\\\"), (2, "echo bar")])

    def test_odd_trailing_backslashes_continue(self) -> None:
        folded = policy.fold_continuations(["echo foo \\\\\\", "bar"])
        self.assertEqual(folded, [(1, "echo foo \\\\ bar")])

    def test_trailing_whitespace_after_backslash_is_not_continuation(self) -> None:
        folded = policy.fold_continuations(["echo foo \\  ", "echo bar"])
        self.assertEqual(folded, [(1, "echo foo \\  "), (2, "echo bar")])


class CollectFailuresTest(unittest.TestCase):
    def _scan(self, workflow_body: str) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflows = root / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "x.yml").write_text(workflow_body)
            return policy.collect_failures(root)

    def test_flags_continued_line_download(self) -> None:
        failures = self._scan(
            "jobs:\n"
            "  build:\n"
            "    steps:\n"
            "      - run: |\n"
            "          curl -fsSL \\\n"
            "            -o /tmp/tool.tgz \\\n"
            "            https://example.com/tool.tgz\n"
        )
        self.assertEqual(len(failures), 1)
        self.assertIn(".github/workflows/x.yml:5", failures[0])

    def test_continued_download_with_openssl_dgst_verification_passes(self) -> None:
        failures = self._scan(
            "jobs:\n"
            "  build:\n"
            "    steps:\n"
            "      - run: |\n"
            "          curl -fsSL \\\n"
            "            -o /tmp/tool.tgz \\\n"
            "            https://example.com/tool.tgz\n"
            "          openssl dgst -sha512 -verify /keys/pub.pem \\\n"
            "            -signature /tmp/tool.tgz.sig /tmp/tool.tgz\n"
        )
        self.assertEqual(failures, [])

    def test_bare_openssl_dgst_hash_print_is_not_verification(self) -> None:
        failures = self._scan(
            "jobs:\n"
            "  build:\n"
            "    steps:\n"
            "      - run: |\n"
            "          curl -o /tmp/tool.tgz https://example.com/tool.tgz\n"
            "          openssl dgst -sha256 /tmp/tool.tgz\n"
        )
        self.assertEqual(len(failures), 1)

    def test_openssl_dgst_with_pinned_hash_comparison_passes(self) -> None:
        failures = self._scan(
            "jobs:\n"
            "  build:\n"
            "    steps:\n"
            "      - run: |\n"
            "          curl -o /tmp/tool.tgz https://example.com/tool.tgz\n"
            '          HASH=$(openssl dgst -sha512 -binary /tmp/tool.tgz | openssl base64 -A)\n'
            '          test "${HASH}" = "${PINNED_HASH}"\n'
        )
        self.assertEqual(failures, [])

    def test_openssl_dgst_with_truthiness_test_is_not_verification(self) -> None:
        # `test "${H}"` only checks non-emptiness; it compares nothing.
        failures = self._scan(
            "jobs:\n"
            "  build:\n"
            "    steps:\n"
            "      - run: |\n"
            "          curl -o /tmp/tool.tgz https://example.com/tool.tgz\n"
            '          H=$(openssl dgst -sha256 /tmp/tool.tgz)\n'
            '          test "${H}"\n'
        )
        self.assertEqual(len(failures), 1)

    def test_single_line_unverified_download_still_flagged(self) -> None:
        failures = self._scan(
            "jobs:\n"
            "  build:\n"
            "    steps:\n"
            "      - run: curl -o /tmp/tool.tgz https://example.com/tool.tgz\n"
        )
        self.assertEqual(len(failures), 1)
        self.assertIn(".github/workflows/x.yml:4", failures[0])


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
