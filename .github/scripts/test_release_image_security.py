"""Exercise release classification, revision binding, and fail-closed scan paths."""

from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / ".github/scripts"
SPEC = importlib.util.spec_from_file_location("release_image_policy", SCRIPTS / "release-image-policy.py")
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)
REPOSITORY = "example/project"


def release_pr(branch="main"):
    return {
        "number": 42, "state": "open", "merge_commit_sha": "c" * 40,
        "head": {"ref": f"release-please--branches--{branch}--components--platform",
                 "sha": "a" * 40, "repo": {"full_name": REPOSITORY}},
        "base": {"ref": branch, "sha": "b" * 40, "repo": {"full_name": REPOSITORY}},
    }


def step_source(source, name):
    section = source.split(f"      - name: {name}\n", 1)[1]
    return re.split(r"^      - name:|^  [a-z][\w-]*:", section, maxsplit=1, flags=re.M)[0]


class ReleasePolicyTests(unittest.TestCase):
    def test_main_and_stable_release_updates_always_scan_without_labels(self):
        for branch in ("main", "release/1.3", "release/1.4", "release/12.30"):
            for action in ("opened", "synchronize", "reopened", "edited"):
                with self.subTest(branch=branch, action=action):
                    self.assertTrue(POLICY.requires_scan("pull_request", {
                        "action": action, "pull_request": release_pr(branch),
                    }, REPOSITORY))

    def test_feature_fork_label_and_merge_queue_do_not_build_scan_candidates(self):
        pr = release_pr()
        pr["head"]["ref"] = "feature"
        for repo in (REPOSITORY, "contributor/fork"):
            pr["head"]["repo"]["full_name"] = repo
            self.assertFalse(POLICY.requires_scan("pull_request", {
                "pull_request": pr, "label": {"name": "run-docker-scan"},
            }, REPOSITORY))
        for event in ("merge_group", "workflow_dispatch"):
            self.assertFalse(POLICY.requires_scan(event, {}, REPOSITORY))
        with self.assertRaises(ValueError):
            POLICY.requires_scan("push", {}, REPOSITORY)

    def test_unexpected_release_branches_and_fork_spoofs_fail_closed(self):
        for path, value in (
            (("base", "ref"), "feature"),
            (("base", "ref"), "release/not-a-version"),
            (("head", "ref"), "release-please--feature"),
            (("head", "repo", "full_name"), "contributor/fork"),
            (("base", "repo", "full_name"), "other/project"),
            (("head", "sha"), ""),
        ):
            with self.subTest(path=path):
                pr = release_pr()
                obj = pr
                for key in path[:-1]:
                    obj = obj[key]
                obj[path[-1]] = value
                with self.assertRaises(ValueError):
                    POLICY.requires_scan("pull_request", {"pull_request": pr}, REPOSITORY)

    def gate(self, **overrides):
        pr = release_pr()
        args = dict(event_name="pull_request", event={"pull_request": pr},
                    repository=REPOSITORY, classify_result="success", decision="true",
                    scan_result="success", current=deepcopy(pr), workflow_sha="c" * 40) | overrides
        POLICY.validate_gate(**args)

    def test_every_failed_cancelled_skipped_or_missing_result_blocks_release(self):
        self.gate()
        for value in ("failure", "cancelled", "skipped", "", "neutral"):
            for field in ("classify_result", "scan_result"):
                with self.subTest(value=value, field=field), self.assertRaises(ValueError):
                    self.gate(**{field: value})
        for value in ("", "false", "unknown"):
            with self.assertRaises(ValueError):
                self.gate(decision=value)

    def test_pr_updates_base_changes_retargeting_and_closed_prs_invalidate_scan(self):
        for field, key, value in (
            ("head", "sha", "d" * 40), ("base", "sha", "e" * 40),
            ("head", "ref", "feature"), ("base", "ref", "release/1.4"),
        ):
            with self.subTest(field=field, key=key), self.assertRaises(ValueError):
                pr = release_pr()
                pr[field][key] = value
                self.gate(current=pr)
        for key, value in (("state", "closed"), ("number", 43), ("merge_commit_sha", "d" * 40)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.gate(current=release_pr() | {key: value})
        with self.assertRaises(ValueError):
            self.gate(current=None)
        for sha in (None, "", "d" * 40):
            with self.subTest(workflow_sha=sha), self.assertRaises(ValueError):
                self.gate(workflow_sha=sha)

    def test_stale_event_merge_sha_passes_when_live_candidate_matches_scanned_commit(self):
        stale = release_pr() | {"merge_commit_sha": "0" * 40}
        self.gate(event={"pull_request": stale})
        stale["merge_commit_sha"] = None
        self.gate(event={"pull_request": stale})

    def test_nonrelease_pass_requires_an_explicit_successful_classification(self):
        for event in ("merge_group", "workflow_dispatch"):
            self.gate(event_name=event, event={}, current=None, decision="false", scan_result="skipped")
            with self.assertRaises(ValueError):
                self.gate(event_name=event, event={}, current=None, decision="", scan_result="skipped")

    def run_gate(self, github_sha, gh_script):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            event = root / "event.json"
            # GitHub can deliver the previous test merge in the event payload.
            event.write_text(json.dumps({"pull_request": release_pr() | {"merge_commit_sha": "0" * 40}}))
            (root / "current.json").write_text(json.dumps(release_pr()))
            gh = root / "gh"
            gh.write_text(gh_script.format(current=root / "current.json"))
            gh.chmod(0o755)
            env = os.environ | {"PATH": f"{root}:{os.environ['PATH']}",
                "GITHUB_EVENT_PATH": str(event), "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_SHA": github_sha,
                "CLASSIFY_RESULT": "success", "SCAN_REQUIRED": "true", "SCAN_RESULT": "success"}
            return subprocess.run(["python3", str(SCRIPTS / "release-image-policy.py"), "gate"],
                env=env, text=True, capture_output=True)

    def test_gate_binds_scans_to_the_live_merge_candidate(self):
        live = "#!/bin/sh\ncat {current}\n"
        result = self.run_gate("c" * 40, live)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for sha, gh in (("d" * 40, live), ("c" * 40, "#!/bin/sh\nexit 23\n")):
            with self.subTest(sha=sha, gh=gh):
                result = self.run_gate(sha, gh)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)


class ReleaseDigestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.digests = self.root / "digests"
        self.digests.mkdir()
        self.sha = "a" * 40
        (self.root / "git").write_text(f"#!/bin/sh\necho {self.sha}\n")
        (self.root / "docker").write_text('''#!/usr/bin/env python3
import json, os, sys
if os.environ.get('FAIL_INSPECT'): sys.exit(23)
digest = sys.argv[4].split('@sha256:')[1]
arches = json.loads(os.environ['ARCHES'])
platforms = arches[digest]
print(json.dumps({'manifests': [
    {'platform': {'os': 'linux', 'architecture': arch}} for arch in platforms
] + [{'platform': {'os': 'unknown', 'architecture': 'unknown'},
      'annotations': {'vnd.docker.reference.type': 'attestation-manifest'}}]}))
''')
        for name in ("git", "docker"):
            (self.root / name).chmod(0o755)

    def resolve(self, architectures=("amd64", "arm64"), revisions=None, **overrides):
        for file in self.digests.iterdir():
            file.unlink()
        arches = {}
        for index, architecture in enumerate(architectures):
            digest = f"{index + 1:064x}"
            (self.digests / digest).write_text((revisions or {}).get(index, self.sha) + "\n")
            arches[digest] = architecture if isinstance(architecture, list) else [architecture]
        output = self.root / "output"
        output.unlink(missing_ok=True)
        result = subprocess.run(["bash", str(SCRIPTS / "release-scan-inputs.sh"), str(self.digests)],
            env=os.environ | {"PATH": f"{self.root}:{os.environ['PATH']}",
                "IMAGE": "registry.example/image", "AMD64_ONLY": "false",
                "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(self.root / "summary"),
                "ARCHES": json.dumps(arches)} | overrides,
            capture_output=True, text=True)
        return result, output.read_text() if output.exists() else ""

    def test_complete_same_revision_set_resolves_immutable_architecture_inputs(self):
        result, output = self.resolve()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(output.splitlines(), [
            f"amd64=registry://registry.example/image@sha256:{1:064x}",
            f"arm64=registry://registry.example/image@sha256:{2:064x}",
        ])
        result, output = self.resolve(("amd64",), AMD64_ONLY="true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("arm64=\n", output)

    def test_incomplete_duplicate_unexpected_and_multiarch_inputs_block(self):
        for arches, policy in (
            ((), "false"), (("amd64",), "false"), (("arm64",), "true"),
            (("amd64", "amd64"), "false"), (("arm64", "arm64"), "false"),
            (("amd64", "ppc64le"), "false"), ((["amd64", "arm64"], "arm64"), "false"),
            (("amd64", "arm64", "arm64"), "false"), (("amd64", "arm64"), "unknown"),
        ):
            with self.subTest(arches=arches, policy=policy):
                result, output = self.resolve(arches, AMD64_ONLY=policy)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(output, "")

    def test_wrong_missing_revision_and_registry_errors_do_not_produce_scan_inputs(self):
        for revisions, overrides in (
            ({0: "b" * 40}, {}), ({1: ""}, {}), ({}, {"FAIL_INSPECT": "1"}),
        ):
            with self.subTest(revisions=revisions, overrides=overrides):
                result, output = self.resolve(revisions=revisions, **overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, "")


class ScannerFailureTests(unittest.TestCase):
    def scan(self, statuses, platform="linux/arm64", concurrent="false"):
        source = (ROOT / ".github/actions/scan-docker-image/action.yml").read_text()
        scanner = textwrap.dedent(source.split("    - name: Docker Scout CVE Check\n", 1)[1].split("      run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cli = root / "docker-scout-1.24.0/docker-scout"
            cli.parent.mkdir()
            cli.write_text('''#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CALLS'], 'a') as calls: calls.write(json.dumps(sys.argv[1:]) + '\\n')
exit(int(json.loads(os.environ['STATUSES'])[sys.argv[2]]))
''')
            cli.chmod(0o755)
            calls = root / "calls"
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", scanner],
                env=os.environ | {"RUNNER_TEMP": directory, "SCOUT_IMAGE": "registry://image@sha256:first",
                    "SCOUT_ADDITIONAL_IMAGES": "registry://image@sha256:second",
                    "SCOUT_PLATFORM": platform, "SCOUT_CONCURRENT": concurrent,
                    "SCOUT_ONLY_SEVERITIES": "critical,high", "SCOUT_ONLY_FIXED": "true",
                    "SCOUT_EXIT_CODE": "true", "CALLS": str(calls),
                    "STATUSES": json.dumps(dict(zip(("registry://image@sha256:first",
                                                     "registry://image@sha256:second"), statuses)))},
                capture_output=True, text=True)
            return result, [json.loads(line) for line in calls.read_text().splitlines()]

    def test_cve_cli_auth_network_and_partial_failures_never_pass(self):
        for concurrent in ("false", "true"):
            for statuses in ((0, 0), (2, 0), (0, 2), (1, 0), (0, 23), (137, 0)):
                with self.subTest(statuses=statuses, concurrent=concurrent):
                    result, calls = self.scan(statuses, concurrent=concurrent)
                    self.assertEqual(result.returncode, max(statuses), result.stderr)
                    self.assertEqual(len(calls), 2)
                    for args in calls:
                        self.assertIn("--exit-code", args)
                        self.assertIn("--only-fixed", args)
                        self.assertEqual(args[args.index("--only-severity") + 1], "critical,high")
                        self.assertEqual(args[args.index("--platform") + 1], "linux/arm64")


class WorkflowContractTests(unittest.TestCase):
    def test_tagging_follows_both_scans_and_release_reuse_is_disabled(self):
        source = (ROOT / ".github/workflows/build-native-multi-arch-image.yml").read_text()
        # Guard the orchestration boundary: failures in either real scan action
        # must prevent version-tag creation, including recovered older releases.
        resolve = source.index("      - name: Resolve release scan inputs")
        amd64 = source.index("      - name: Scan release amd64 bytes before tagging")
        arm64 = source.index("      - name: Scan release arm64 bytes before tagging")
        tag = source.index("      - name: Create manifest list and push")
        self.assertLess(resolve, amd64)
        self.assertLess(amd64, arm64)
        self.assertLess(arm64, tag)
        for name in ("Scan release amd64 bytes before tagging", "Scan release arm64 bytes before tagging"):
            section = step_source(source, name)
            self.assertNotIn("continue-on-error", section)
            self.assertIn('exit-code: "true"', section)
        # This release line predates image reuse: every release build must run.
        self.assertNotIn("  reuse-image:\n", source)
        checkout = step_source(source.split("  merge-manifests:\n", 1)[1], "Checkout repository")
        self.assertIn("inputs.checkout_ref", checkout)

    def test_release_security_gate_is_always_run_and_contexts_depend_on_its_result(self):
        source = (ROOT / ".github/workflows/docker-image-scanning.yml").read_text()
        gate = source.split("  release-image-security:\n", 1)[1].split("  required-contexts:\n", 1)[0]
        self.assertIn("if: ${{ always() }}", gate)
        self.assertIn("needs: [classify, scan-release-images]", gate)
        for job in ("required-contexts", "legacy-required-context"):
            section = re.search(rf"^  {job}:\n(.*?)(?=^  [\w-]+:|\Z)", source, re.M | re.S).group(1)
            self.assertIn("if: ${{ always() && github.event_name != 'merge_group' }}", section)
            self.assertIn("needs: [release-image-security]", section)
            for result in ("success", "failure", "cancelled", "skipped", ""):
                command = section.split("        run: ", 1)[1].splitlines()[0]
                completed = subprocess.run(["bash", "-e", "-c", command],
                    env=os.environ | {"RESULT": result})
                self.assertEqual(completed.returncode == 0, result == "success")
        e2e = (ROOT / ".github/workflows/platform-e2e-tests.yml").read_text()
        queue = e2e.split("  merge-queue-image-scanning:\n", 1)[1].split("  platform-e2e-cancel-on-build-failure:\n", 1)[0]
        self.assertIn("github.event_name == 'merge_group'", queue)
        self.assertIn("needs: [platform-e2e-build]", queue)
        self.assertIn("uses: ./.github/actions/scan-docker-image", queue)
        self.assertIn('exit-code: "true"', queue)
        p4 = source.split("  merge-queue-p4-image-scanning:\n", 1)[1]
        self.assertIn("github.event_name == 'merge_group'", p4)
        self.assertIn('exit-code: "true"', p4)
        self.assertNotIn("run-docker-scan", source)


if __name__ == "__main__":
    unittest.main()
