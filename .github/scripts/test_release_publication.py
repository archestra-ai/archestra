"""Exercise the real publication guard, stubbing only the GitHub CLI boundary."""

import json
import os
from pathlib import Path
import subprocess
import textwrap
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / "workflows/release-please.yml"


class ReleasePublicationTests(unittest.TestCase):
    def run_guard(self, releases=(), *, api_status=0, version="1.3.51", freeze="false"):
        section = WORKFLOW.read_text().split(
            "      - name: Check publication is still allowed\n", 1
        )[1].split("      - name:", 1)[0]
        script = textwrap.dedent(section.split("        run: |\n", 1)[1])
        # Use the workflow's actual --jq expression, not a duplicate of its filter.
        stub = """
gh() {
  local query=
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --jq ]; then query=$2; shift; fi
    shift
  done
  printf '%s\\n' "$RELEASES" | jq -r "$query"
  return "$API_STATUS"
}
"""
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c",
             stub + script + "\nprintf 'PROMOTION_ALLOWED\\n'"],
            env={
                **os.environ,
                "RELEASES": json.dumps(releases),
                "API_STATUS": str(api_status),
                "VERSION": version,
                "TAG_NAME": f"platform-v{version}",
                "GH_REPO": "fixture/repo",
                "RELEASE_FREEZE": freeze,
            },
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result

    def assert_allowed(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PROMOTION_ALLOWED", result.stdout)

    def assert_blocked(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("PROMOTION_ALLOWED", result.stdout)

    def test_first_stable_release(self):
        self.assert_allowed(self.run_guard())

    def test_api_failure_blocks_even_with_partial_page_output(self):
        for releases in ([], [{"tag_name": "platform-v1.3.50", "prerelease": False}]):
            with self.subTest(releases=releases):
                result = self.run_guard(releases, api_status=1)
                self.assert_blocked(result)
                self.assertIn("Cannot verify stable release ordering", result.stdout)

    def test_higher_stable_blocks_published_and_draft(self):
        for draft in (False, True):
            with self.subTest(draft=draft):
                self.assert_blocked(self.run_guard([
                    {"tag_name": "platform-v1.4.0", "prerelease": False, "draft": draft}
                ]))

    def test_older_and_same_stable_allow_retry(self):
        self.assert_allowed(self.run_guard([
            {"tag_name": "platform-v1.3.50", "prerelease": False, "draft": False},
            {"tag_name": "platform-v1.3.51", "prerelease": False, "draft": True},
        ]))

    def test_numeric_version_ordering(self):
        self.assert_blocked(self.run_guard([
            {"tag_name": "platform-v1.10.0", "prerelease": False}
        ], version="1.9.1"))

    def test_prereleases_and_other_components_do_not_block(self):
        self.assert_allowed(self.run_guard([
            {"tag_name": "platform-v2.0.0-beta.1", "prerelease": True},
            {"tag_name": "other-v2.0.0", "prerelease": False},
        ]))

    def test_beta_does_not_depend_on_stable_lookup(self):
        self.assert_allowed(self.run_guard(api_status=1, version="1.4.0-beta.1"))

    def test_freeze_blocks_both_channels(self):
        for version in ("1.3.51", "1.4.0-beta.1"):
            with self.subTest(version=version):
                self.assert_blocked(self.run_guard(version=version, freeze="true"))


if __name__ == "__main__":
    unittest.main()
