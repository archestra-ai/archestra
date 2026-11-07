"""Exercise publication scripts, stubbing only external CLI boundaries."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / "workflows/release-please.yml"
POLICY = Path(__file__).resolve().parent / "release-publication-policy.sh"


class ReleasePublicationTests(unittest.TestCase):
    def run_guard(self, releases=(), *, api_status=0, version="1.3.51", freeze="false", ref="release/1.3"):
        script = POLICY.read_text()
        # Use the script's actual --jq expression, not a duplicate of its filter.
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
        output = tempfile.NamedTemporaryFile(mode="w+")
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
                "GITHUB_REF_NAME": ref,
                "GITHUB_OUTPUT": output.name,
            },
            capture_output=True,
            text=True,
            timeout=10,
        )
        result.policy_output = Path(output.name).read_text()
        output.close()
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
                    {"tag_name": "platform-v1.3.52", "prerelease": False, "draft": draft}
                ]))

    def test_older_lines_publish_without_taking_over_newer_channels(self):
        for version, newer in (
            ("1.3.80", "1.4.17"), ("1.3.81", "1.4.18"),
            ("1.4.18", "1.5.0"), ("1.5.9", "1.6.0"), ("2.9.7", "2.10.0"),
        ):
            for draft in (False, True):
                with self.subTest(version=version, newer=newer, draft=draft):
                    releases = [{"tag_name": f"platform-v{newer}", "prerelease": False, "draft": draft}]
                    result = self.run_guard(releases, version=version, ref=f"release/{version.rsplit('.', 1)[0]}")
                    self.assert_allowed(result)
                    self.assertEqual(result.policy_output, "preserve_latest=true\n")
                    self.assert_blocked(self.run_guard(releases, version=version, freeze="true"))
                    self.assert_blocked(self.run_guard(releases, version=version, api_status=1))

    def test_same_line_newer_patch_blocks_partial_publication_and_retries(self):
        for version, newer in (("1.3.80", "1.3.81"), ("1.4.18", "1.4.19"), ("1.5.9", "1.5.10")):
            for draft in (False, True):
                with self.subTest(version=version, newer=newer, draft=draft):
                    self.assert_blocked(self.run_guard([
                        {"tag_name": "platform-v9.0.0", "prerelease": False},
                        {"tag_name": f"platform-v{newer}", "prerelease": False, "draft": draft},
                    ], version=version, ref=f"release/{version.rsplit('.', 1)[0]}"))

    def test_stable_version_must_match_release_branch(self):
        for ref in ("main", "release/1.4", "release/1.30", "feature/example"):
            with self.subTest(ref=ref):
                self.assert_blocked(self.run_guard(version="1.3.80", ref=ref))

    def test_newest_stable_line_promotes_latest(self):
        result = self.run_guard([
            {"tag_name": "platform-v1.3.99", "prerelease": False},
            {"tag_name": "platform-v1.4.18", "prerelease": False, "draft": True},
        ], version="1.4.18", ref="release/1.4")
        self.assert_allowed(result)
        self.assertEqual(result.policy_output, "preserve_latest=false\n")

    def test_older_and_same_stable_allow_retry(self):
        self.assert_allowed(self.run_guard([
            {"tag_name": "platform-v1.3.50", "prerelease": False, "draft": False},
            {"tag_name": "platform-v1.3.51", "prerelease": False, "draft": True},
        ]))

    def test_numeric_version_ordering(self):
        result = self.run_guard([
            {"tag_name": "platform-v1.10.0", "prerelease": False}
        ], version="1.9.1", ref="release/1.9")
        self.assert_allowed(result)
        self.assertEqual(result.policy_output, "preserve_latest=true\n")

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
        )[1].split("\n  # release-please runs", 1)[0]
        script = textwrap.dedent(section.split("        run: |\n", 1)[1])
        for version, override, allowed, create_pr in (
            ("1.4.0-beta.13", "1.4.0-rc.14", True, True),
            ("1.4.0-rc.14", "1.4.0-rc.14", True, False),
            ("1.4.0-rc.14", None, True, True),
            ("1.4.0-rc.15", None, True, True),
            ("1.4.0-rc.35", "1.4.0-rc.36", True, True),
            ("1.4.0-rc.36", "1.4.0-rc.36", True, False),
            ("1.4.0-rc.36", None, True, True),
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

    def test_release_jobs_write_no_public_registry_names(self):
        # Only the release-images publisher writes public names; this
        # repository stages in ghcr.io/archestra-ai/ci and attests.
        for workflow in (WORKFLOW, WORKFLOW.with_name("publish-platform-helm-chart.yml"),
                         WORKFLOW.with_name("build-platform-release-image.yml")):
            source = workflow.read_text()
            with self.subTest(workflow=workflow.name):
                for command in ("helm push", "imagetools create", "docker push", "skopeo copy",
                                "auth_provider: dockerhub", "auth_provider: gar"):
                    self.assertNotIn(command, source)

    def run_platform_latest(self, releases=(), *, version, api_status=0, preserve_latest="false"):
        section = WORKFLOW.read_text().split(
            "      - name: Decide whether the platform latest tag moves\n", 1
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
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            result = subprocess.run(
                ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", stub + script],
                cwd=directory,
                env={
                    **os.environ,
                    "RELEASES": json.dumps(releases),
                    "API_STATUS": str(api_status),
                    "VERSION": version, "PRESERVE_LATEST": preserve_latest,
                    "GH_REPO": "fixture/repo", "GITHUB_OUTPUT": str(output),
                },
                capture_output=True,
                text=True,
                timeout=10,
            )
            result.decision = output.read_text().splitlines() if output.exists() else []
            return result

    def test_platform_latest_follows_newest_published_release(self):
        def published(*versions, draft=False):
            return [{"tag_name": f"platform-v{v}", "draft": draft} for v in versions]

        for releases, version, moves in (
            ((), "1.4.0-rc.22", True),
            (published("1.4.0-rc.22"), "1.4.0-rc.22", True),  # retry
            (published("1.4.0-rc.22", "1.3.66"), "1.4.0-rc.23", True),
            (published("1.4.0-rc.9"), "1.4.0-rc.10", True),
            (published("1.4.0-beta.13"), "1.4.0-rc.14", True),
            (published("1.4.0-rc.22"), "1.4.0", True),
            (published("1.4.0-rc.22", draft=True), "1.4.0-rc.22", True),
            (published("1.4.0-rc.23", draft=True), "1.4.0-rc.22", False),
            (published("1.5.0-rc.1", draft=True), "1.4.0-rc.22", False),
            ([{"tag_name": "other-v9.0.0", "draft": False}], "1.4.0-rc.22", True),
            (published("1.4.0-rc.22", "1.3.66"), "1.3.67", False),
            (published("1.10.0-rc.1"), "1.9.3", False),
            (published("1.4.0"), "1.4.0-rc.23", False),
            (published("1.4.0-rc.23"), "1.4.0-rc.22", False),
        ):
            with self.subTest(releases=releases, version=version):
                result = self.run_platform_latest(releases, version=version)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(result.decision, [f"move={'true' if moves else 'false'}"])

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
        self.assertEqual(result.decision, [])
        self.assertIn("Cannot list releases", result.stdout)

    def test_older_line_patch_never_moves_platform_latest(self):
        result = self.run_platform_latest(version="1.3.80", preserve_latest="true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.decision, ["move=false"])

    def test_older_line_patch_publishes_github_release_without_latest(self):
        section = WORKFLOW.read_text().split("      - name: Publish GitHub release\n", 1)[1]
        lines = section.split("        run: |\n", 1)[1].splitlines()
        script_lines = []
        for line in lines:
            if line.strip() and not line.startswith("          "):
                break
            script_lines.append(line)
        script = textwrap.dedent("\n".join(script_lines))
        env = os.environ | {"VERSION": "1.3.80", "TAG_NAME": "platform-v1.3.80", "PRESERVE_LATEST": "true"}
        result = subprocess.run(
            ["bash", "-eo", "pipefail", "-c", 'gh() { if [ "$1 $2" = "release view" ]; then echo true; else echo "gh $*"; fi; };\n' + script],
            env=env, capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--draft=false --prerelease=false --latest=false", result.stdout)

SCRIPTS = Path(__file__).resolve().parent
DIGEST_A, DIGEST_B = "a" * 64, "b" * 64


class PublisherHandoffTests(unittest.TestCase):
    GAR = "europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public"
    STAGED = {
        "platform": f"ghcr.io/archestra-ai/ci/platform@sha256:{DIGEST_B}",
        "mcp-server-base": f"ghcr.io/archestra-ai/ci/mcp-server-base@sha256:{DIGEST_A}",
    }

    def collect(self, references, registry="ghcr.io/archestra-ai", chart=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        staged = Path(directory.name) / "release-images"
        staged.mkdir()
        for name, reference in references.items():
            (staged / name).write_text(reference)
        args = ["bash", str(SCRIPTS / "release-subjects.sh"), "release-images", registry]
        if chart:
            (Path(directory.name) / chart[0]).write_bytes(chart[1])
            args.append(chart[0])
        result = subprocess.run(args, cwd=directory.name, capture_output=True, text=True, timeout=10)
        outputs = {}
        for name in ("release-subjects.txt", "release-images.json", "release-pins.json"):
            path = Path(directory.name) / name
            outputs[name] = path.read_text() if path.exists() else None
        return result, outputs

    def test_subjects_use_each_public_name_and_the_chart_file(self):
        chart = ("archestra-platform-1.4.0.tgz", b"chart")
        for registry in ("ghcr.io/archestra-ai", self.GAR):
            with self.subTest(registry=registry):
                result, outputs = self.collect(self.STAGED, registry, chart)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(sorted(outputs["release-subjects.txt"].splitlines()), sorted([
                    f"{DIGEST_A}  {registry}/mcp-server-base",
                    f"{DIGEST_B}  docker.io/archestra/platform",
                    f"{hashlib.sha256(b'chart').hexdigest()}  archestra-platform-1.4.0.tgz",
                ]))
                self.assertEqual(json.loads(outputs["release-images.json"]), {
                    f"{registry}/mcp-server-base": f"sha256:{DIGEST_A}",
                    "docker.io/archestra/platform": f"sha256:{DIGEST_B}",
                })
                self.assertEqual(json.loads(outputs["release-pins.json"]), {
                    "mcp-server-base": f"sha256:{DIGEST_A}", "platform": f"sha256:{DIGEST_B}",
                })

    def test_subjects_reject_references_that_do_not_match_their_image(self):
        for references, registry in (
            # Another image's digest under this name.
            ({**self.STAGED, "mcp-server-base": f"ghcr.io/archestra-ai/ci/agent-codex@sha256:{DIGEST_A}"}, None),
            # A public name instead of the ci/ staging repository.
            ({**self.STAGED, "platform": f"docker.io/archestra/platform@sha256:{DIGEST_A}"}, None),
            ({**self.STAGED, "mcp-server-base": f"ghcr.io/archestra-ai/mcp-server-base@sha256:{DIGEST_A}"}, None),
            # A tag instead of a digest.
            ({**self.STAGED, "mcp-server-base": "ghcr.io/archestra-ai/ci/mcp-server-base:1.4.0"}, None),
            # The platform and mcp-server-base ship with every release.
            ({"mcp-server-base": self.STAGED["mcp-server-base"]}, None),
            ({"platform": self.STAGED["platform"]}, None),
            # Only the known public registries.
            (self.STAGED, "docker.io/archestra"),
        ):
            with self.subTest(references=references, registry=registry):
                result, _ = self.collect(references, registry or "ghcr.io/archestra-ai")
                self.assertNotEqual(result.returncode, 0)

    def dispatch(self, *, version, preserve_latest, runs, platform_latest="false", chart=None):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        images = Path(directory.name) / "images.json"
        images.write_text(json.dumps({"ghcr.io/archestra-ai/mcp-server-base": f"sha256:{DIGEST_A}"}))
        chart_env = {}
        if chart is not None:
            (Path(directory.name) / "chart.tgz").write_bytes(chart)
            chart_env = {"CHART": str(Path(directory.name) / "chart.tgz")}
        calls = Path(directory.name) / "calls"
        # Stub only the GitHub CLI; the script's own --jq filter runs against
        # the fixture run list.
        stub = r"""
gh() {
  if [ "$1 $2 $3" = "api -X POST" ]; then
    printf 'dispatch %s ' "$4" >> "$CALLS"; jq -c . >> "$CALLS"; return
  fi
  if [ "$1 $2" = "run watch" ]; then echo "watch $3" >> "$CALLS"; return "$WATCH_STATUS"; fi
  local query=
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --jq ]; then query=$2; shift; fi
    shift
  done
  printf '%s\n' "$RUNS" | jq -r "$query"
}
sleep() { :; }
"""
        result = subprocess.run(
            ["bash", "-c", stub + f'source "{SCRIPTS / "release-dispatch.sh"}" "{images}"'],
            env=os.environ | chart_env | {
                "VERSION": version, "PRESERVE_LATEST": preserve_latest, "CALLS": str(calls),
                "PLATFORM_LATEST": platform_latest,
                "PUBLISHER_REPO": "archestra-ai/release-images", "GITHUB_RUN_ID": "77",
                "GITHUB_RUN_ATTEMPT": "2", "RUNS": json.dumps({"workflow_runs": runs}),
                "WATCH_STATUS": "0",
            },
            capture_output=True, text=True, timeout=10,
        )
        lines = calls.read_text().splitlines() if calls.exists() else []
        payload = json.loads(lines[0].split(" ", 2)[2]) if lines else None
        return result, payload, lines[1:]

    def test_dispatch_moves_latest_only_for_the_newest_stable_line(self):
        runs = [{"id": 5, "display_title": "Publish 1.4.0 [77-2]"}]
        for version, preserve, latest in (
            ("1.4.0", "false", True), ("1.3.80", "true", False), ("1.5.0-rc.3", "false", False),
        ):
            with self.subTest(version=version):
                result, payload, rest = self.dispatch(version=version, preserve_latest=preserve, runs=runs)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(payload, {
                    "event_type": "publish-release-images",
                    "client_payload": {"request_id": "77-2", "version": version, "latest": latest,
                                       "platform_latest": False,
                                       "images": {"ghcr.io/archestra-ai/mcp-server-base": f"sha256:{DIGEST_A}"}},
                })
                self.assertEqual(rest, ["watch 5"])

    def test_dispatch_names_the_chart_of_this_run_and_the_platform_latest_decision(self):
        runs = [{"id": 5, "display_title": "Publish 1.5.0-rc.3 [77-2]"}]
        result, payload, _ = self.dispatch(version="1.5.0-rc.3", preserve_latest="false", runs=runs,
                                           platform_latest="true", chart=b"chart")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["client_payload"]["platform_latest"], True)
        self.assertEqual(payload["client_payload"]["chart"],
                         {"run_id": 77, "sha256": hashlib.sha256(b"chart").hexdigest()})

    def test_dispatch_waits_only_for_its_own_run(self):
        runs = [{"id": 4, "display_title": "Publish 1.4.0 [77-1]"},
                {"id": 3, "display_title": "Publish 1.4.0 [177-2]"}]
        result, _, rest = self.dispatch(version="1.4.0", preserve_latest="false", runs=runs)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not start", result.stdout)
        self.assertEqual(rest, [])


if __name__ == "__main__":
    unittest.main()
