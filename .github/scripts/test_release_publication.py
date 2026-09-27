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

    def test_beta_does_not_depend_on_stable_lookup(self):
        self.assert_allowed(self.run_guard(api_status=1, version="1.4.0-beta.1"))

    def test_freeze_blocks_both_channels(self):
        for version in ("1.3.51", "1.4.0-beta.1"):
            with self.subTest(version=version):
                self.assert_blocked(self.run_guard(version=version, freeze="true"))

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
                ])

    PLATFORM_IMAGE = "archestra/platform@sha256:" + "b" * 64

    def run_platform_latest(self, releases=(), *, version, api_status=0):
        section = WORKFLOW.read_text().split(
            "      - name: Move the platform latest tag\n", 1
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
docker() { printf 'docker %s\\n' "$*"; }
"""
        with tempfile.TemporaryDirectory() as directory:
            images = Path(directory) / "release-images"
            images.mkdir()
            (images / "platform").write_text(self.PLATFORM_IMAGE)
            return subprocess.run(
                ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", stub + script],
                cwd=directory,
                env={
                    **os.environ,
                    "RELEASES": json.dumps(releases),
                    "API_STATUS": str(api_status),
                    "VERSION": version,
                    "GH_REPO": "fixture/repo",
                },
                capture_output=True,
                text=True,
                timeout=10,
            )

    def test_platform_latest_follows_newest_published_release(self):
        def published(*versions, draft=False):
            return [{"tag_name": f"platform-v{v}", "draft": draft} for v in versions]

        tagged = f"docker buildx imagetools create --tag archestra/platform:latest {self.PLATFORM_IMAGE}"
        for releases, version, moves in (
            ((), "1.4.0-rc.22", True),
            (published("1.4.0-rc.22"), "1.4.0-rc.22", True),  # retry
            (published("1.4.0-rc.22", "1.3.66"), "1.4.0-rc.23", True),
            (published("1.4.0-rc.9"), "1.4.0-rc.10", True),
            (published("1.4.0-beta.13"), "1.4.0-rc.14", True),
            (published("1.4.0-rc.22"), "1.4.0", True),
            (published("1.5.0-rc.1", draft=True), "1.4.0-rc.22", True),
            ([{"tag_name": "other-v9.0.0", "draft": False}], "1.4.0-rc.22", True),
            (published("1.4.0-rc.22", "1.3.66"), "1.3.67", False),
            (published("1.10.0-rc.1"), "1.9.3", False),
            (published("1.4.0"), "1.4.0-rc.23", False),
            (published("1.4.0-rc.23"), "1.4.0-rc.22", False),
        ):
            with self.subTest(releases=releases, version=version):
                result = self.run_platform_latest(releases, version=version)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                if moves:
                    self.assertEqual(result.stdout.splitlines(), [tagged])
                else:
                    self.assertNotIn(tagged, result.stdout)

    def test_previous_release_comes_from_the_same_branch(self):
        section = WORKFLOW.read_text().split(
            "      - name: Resolve previous release on this branch\n", 1
        )[1].split("      - name:", 1)[0]
        script = textwrap.dedent(section.split("        run: |\n", 1)[1])

        def git(root, *args):
            return subprocess.run(
                ["git", "-C", str(root), *args], check=True, capture_output=True, text=True
            ).stdout.strip()

        def commit(root, tag=None):
            git(root, "commit", "--allow-empty", "-q", "-m", tag or "change")
            if tag:
                git(root, "tag", tag)
            return git(root, "rev-parse", "HEAD")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git(root, "init", "-q", "-b", "main")
            git(root, "config", "user.email", "ci@example.invalid")
            git(root, "config", "user.name", "CI")
            first = commit(root)
            commit(root, "platform-v1.3.66")
            git(root, "checkout", "-q", "-b", "release/1.3")
            stable = commit(root, "platform-v1.3.67")
            git(root, "checkout", "-q", "main")
            commit(root, "platform-v1.4.0-rc.22")
            commit(root, "other-v9.0.0")
            candidate = commit(root, "platform-v1.4.0-rc.23")

            for release_sha, previous in (
                (candidate, "1.4.0-rc.22"),
                (stable, "1.3.66"),
                (first, ""),
            ):
                with self.subTest(previous=previous):
                    output = root / "output"
                    result = subprocess.run(
                        ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                        cwd=root,
                        env={**os.environ, "RELEASE_SHA": release_sha, "GITHUB_OUTPUT": str(output)},
                        capture_output=True, text=True, timeout=10,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(output.read_text().splitlines(), [f"version={previous}"])
                    output.unlink()

    def test_platform_latest_stays_when_release_list_fails(self):
        result = self.run_platform_latest(version="1.4.0-rc.22", api_status=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("docker", result.stdout)
        self.assertIn("Cannot list releases", result.stdout)


if __name__ == "__main__":
    unittest.main()
