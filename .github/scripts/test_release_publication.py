"""Exercise publication scripts, stubbing only external CLI boundaries."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
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

    def test_prereleases_do_not_depend_on_stable_lookup(self):
        for version in ("1.4.0-beta.13", "1.4.0-rc.14"):
            with self.subTest(version=version):
                self.assert_allowed(self.run_guard(api_status=1, version=version))

    def test_freeze_blocks_both_channels(self):
        for version in ("1.3.51", "1.4.0-beta.13", "1.4.0-rc.14"):
            with self.subTest(version=version):
                self.assert_blocked(self.run_guard(version=version, freeze="true"))

    def test_github_publication_marks_prereleases_without_latest(self):
        section = WORKFLOW.read_text().split(
            "      - name: Publish GitHub release\n", 1
        )[1]
        # The publish step can be the last step in its job.
        lines = section.split("        run: |\n", 1)[1].splitlines()
        script_lines = []
        for line in lines:
            if line.strip() and not line.startswith("          "):
                break
            script_lines.append(line)
        script = textwrap.dedent("\n".join(script_lines))
        stub = "gh() { if [ \"$2\" = view ]; then echo true; else printf '%s\\n' \"$*\"; fi; };\n"
        for version, flags in (
            ("1.4.0-beta.13", "--prerelease --latest=false"),
            ("1.4.0-rc.14", "--prerelease --latest=false"),
            ("1.4.0", "--prerelease=false --latest"),
        ):
            with self.subTest(version=version):
                result = subprocess.run(
                    ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", stub + script],
                    env={**os.environ, "VERSION": version, "TAG_NAME": f"platform-v{version}"},
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [
                    f"release upload platform-v{version} archestra-platform-{version}.tgz --clobber",
                    f"release edit platform-v{version} --draft=false {flags}",
                ])

    def test_main_policy_rc_transition_and_rolling_releases(self):
        section = WORKFLOW.read_text().split(
            "      - name: Validate branch release policy\n", 1
        )[1].split("      # release-please runs", 1)[0]
        script = textwrap.dedent(section.split("        run: |\n", 1)[1])
        for version, override, allowed, create_pr in (
            ("1.4.0-beta.13", "1.4.0-rc.14", True, True),
            ("1.4.0-rc.14", "1.4.0-rc.14", True, False),
            ("1.4.0-rc.14", None, True, True),
            ("1.4.0-rc.15", None, True, True),
            ("1.4.0-beta.14", None, False, None),
            ("1.4.0", None, False, None),
            ("1.4.0-rc.0", None, False, None),
            ("1.4.1-rc.1", None, False, None),
        ):
            with self.subTest(version=version, override=override), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config_dir = root / ".github/release-please"
                config_dir.mkdir(parents=True)
                config = {"draft": True, "prerelease": True,
                          "versioning": "prerelease", "prerelease-type": "rc"}
                if override:
                    config["release-as"] = override
                (config_dir / "release-please-config.json").write_text(
                    json.dumps({"packages": {"platform": config}})
                )
                (config_dir / ".release-please-manifest.json").write_text(
                    json.dumps({"platform": version})
                )
                output = root / "output"
                result = subprocess.run(
                    ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                    cwd=root,
                    env={**os.environ, "BRANCH": "main", "RELEASE_FREEZE": "false",
                         "GITHUB_OUTPUT": str(output)},
                    capture_output=True, text=True, timeout=10,
                )
                if allowed:
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual(output.read_text().splitlines(), [
                        f"requested={version}", f"create_pr={str(create_pr).lower()}",
                    ])
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(output.exists())

    def test_chart_destination_is_independent_and_requires_mcp_reference(self):
        section = WORKFLOW.read_text().split(
            "      - name: Publish approved stable artifacts without rebuilding\n", 1
        )[1].split("      - name:", 1)[0]
        script = textwrap.dedent(section.split("        run: |\n", 1)[1])
        mcp_image = "registry.example.invalid/relocated/mcp@sha256:" + "a" * 64
        platform_image = "archestra/platform@sha256:" + "b" * 64
        stub = "helm() { printf 'helm %s\\n' \"$*\"; }; docker() { printf 'docker %s\\n' \"$*\"; };\n"
        for reference in (None, "", mcp_image):
            with self.subTest(reference=reference), tempfile.TemporaryDirectory() as directory:
                images = Path(directory) / "release-images"
                images.mkdir()
                (images / "platform").write_text(platform_image)
                if reference is not None:
                    (images / "mcp-server-base").write_text(reference)
                result = subprocess.run(
                    ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", stub + script],
                    cwd=directory,
                    env={**os.environ, "VERSION": "1.4.0"},
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if not reference:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")
                    continue
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [
                    "helm push archestra-platform-1.4.0.tgz "
                    "oci://europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/helm-charts",
                    f"docker buildx imagetools create --tag registry.example.invalid/relocated/mcp:latest {mcp_image}",
                    f"docker buildx imagetools create --tag archestra/platform:latest {platform_image}",
                ])


if __name__ == "__main__":
    unittest.main()
