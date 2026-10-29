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
from unittest.mock import patch


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
    def test_queue_classification_reads_actual_combined_commits_including_a_mixed_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "CI fixture")
            git("config", "user.email", "fixture@example.invalid")
            manifest = root / ".github/release-please/.release-please-manifest.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text('{"platform":"1.4.0"}')
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            manifest.write_text('{"platform":"1.4.1"}')
            git("commit", "-qam", "release version")
            (root / "feature").write_text("ordinary PR in the same queue group")
            git("add", ".")
            git("commit", "-qm", "ordinary feature")
            group = {"base_ref": "refs/heads/release/1.4", "base_sha": base,
                     "head_sha": git("rev-parse", "HEAD"),
                     "head_ref": "refs/heads/gh-readonly-queue/release/1.4/pr-99-feature"}
            # Exercise real git object reads, stubbing only the checkout location.
            original = subprocess.check_output
            def in_fixture(args, **kwargs):
                return original(args, cwd=directory, **kwargs)
            with patch.object(POLICY.subprocess, "check_output", side_effect=in_fixture):
                self.assertTrue(POLICY.requires_scan("merge_group", {"merge_group": group}, REPOSITORY))
                group["base_sha"] = git("rev-parse", "HEAD^")
                self.assertFalse(POLICY.requires_scan("merge_group", {"merge_group": group}, REPOSITORY))

    def test_scan_inventory_covers_every_published_agent_and_sandbox(self):
        images = POLICY.candidate_matrix(ROOT)["include"]
        by_image = {image["image"]: image for image in images}
        self.assertEqual(len(images), len(by_image))
        publisher = (ROOT / ".github/workflows/build-agent-catalog-images.yml").read_text()
        publish_matrix = publisher.split("      matrix:\n", 1)[1].split("    permissions:", 1)[0]
        published = set(re.findall(r"^\s+- (agent-[a-z0-9-]+)$", publish_matrix, re.M))
        self.assertTrue(published)
        # Follow the release callers and their wrappers so a newly published
        # companion image cannot silently escape the preflight inventory.
        release = (ROOT / ".github/workflows/release-please.yml").read_text()
        for job in re.findall(r"^  [\w-]+:\n(.*?)(?=^  [\w-]+:|\Z)", release, re.M | re.S):
            call = re.search(r"uses: [.$]/\.github/workflows/([\w-]+\.yml)", job)
            if call:
                wrapper = (ROOT / ".github/workflows" / call[1]).read_text()
                published.update(re.findall(r"^\s+image_name: ([a-z0-9-]+)\s*$", job + wrapper, re.M))
        self.assertEqual(set(by_image), published | {"platform-slim"})
        for name in (image for image in published if image.startswith("agent-")):
            self.assertEqual(by_image[name]["target"], name)
            self.assertEqual(by_image[name]["context"], "./platform")
        self.assertEqual(by_image["platform-slim"]["target"], "unified-slim")
        self.assertEqual(by_image["sandbox-base"]["context"], "./platform/docker_images/sandbox_base")

    def test_new_catalog_targets_are_scanned_and_invalid_inventories_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "platform/shared/agent-catalog-images.json"
            catalog.parent.mkdir(parents=True)
            for entry in POLICY.candidate_matrix(ROOT)["include"]:
                file = root / entry["dockerfile"]
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("FROM scratch AS agent-new\n")
            catalog.write_text(json.dumps({"new": "agent-new"}))
            self.assertIn("agent-new", {row["image"] for row in POLICY.candidate_matrix(root)["include"]})
            for value in ({}, {"new": "agent-missing"}, {"a": "agent-new", "b": "agent-new"},
                          {"new": "../escape"}, {"new": 23}):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    catalog.write_text(json.dumps(value))
                    POLICY.candidate_matrix(root)

    def test_classification_emits_complete_matrix_and_ordinary_events_still_skip(self):
        with tempfile.TemporaryDirectory() as directory:
            event, output = Path(directory) / "event", Path(directory) / "output"
            for branch in ("main", "release/1.4", "feature"):
                pr = release_pr(branch if branch != "feature" else "main")
                if branch == "feature":
                    pr["head"]["ref"] = "feature"
                event.write_text(json.dumps({"pull_request": pr}))
                output.unlink(missing_ok=True)
                subprocess.run(["python3", str(SCRIPTS / "release-image-policy.py"), "classify"],
                    env=os.environ | {"GITHUB_EVENT_PATH": str(event), "GITHUB_OUTPUT": str(output),
                        "GITHUB_EVENT_NAME": "pull_request", "GITHUB_REPOSITORY": REPOSITORY}, check=True)
                values = dict(line.split("=", 1) for line in output.read_text().splitlines())
                self.assertEqual(values["scan"], "false")
                self.assertEqual(json.loads(values["matrix"]), {"include": [row | {"arch": arch}
                    for row in POLICY.candidate_matrix(ROOT)["include"] for arch in ("amd64", "arm64")]})

    def test_main_and_stable_release_prs_only_scan_in_the_queue(self):
        for branch in ("main", "release/1.4", "release/12.30"):
            for action in ("opened", "synchronize", "reopened", "edited"):
                with self.subTest(branch=branch, action=action):
                    self.assertTrue(POLICY.is_release_pr(release_pr(branch), REPOSITORY))
                    self.assertFalse(POLICY.requires_scan("pull_request", {
                        "action": action, "pull_request": release_pr(branch),
                    }, REPOSITORY))

    def test_feature_fork_label_and_manual_events_do_not_build_scan_candidates(self):
        pr = release_pr()
        pr["head"]["ref"] = "feature"
        for repo in (REPOSITORY, "contributor/fork"):
            pr["head"]["repo"]["full_name"] = repo
            self.assertFalse(POLICY.requires_scan("pull_request", {
                "pull_request": pr, "label": {"name": "run-docker-scan"},
            }, REPOSITORY))
        for event in ("workflow_dispatch",):
            self.assertFalse(POLICY.requires_scan(event, {}, REPOSITORY))
        with self.assertRaises(ValueError):
            POLICY.requires_scan("push", {}, REPOSITORY)

    def test_queue_release_and_mixed_groups_scan_the_complete_combined_revision(self):
        group = {"base_ref": "refs/heads/main", "head_ref": "refs/heads/gh-readonly-queue/main/pr-99-test",
                 "head_sha": "c" * 40, "base_sha": "b" * 40}
        for branch in ("main", "release/1.4"):
            group.update(base_ref=f"refs/heads/{branch}", head_ref=f"refs/heads/gh-readonly-queue/{branch}/pr-99-test")
            for before, after, required in (("1.4.0", "1.4.1", True), ("1.4.0", "1.4.0", False)):
                with patch.object(POLICY, "queue_versions", return_value=[before, after]):
                    event = {"merge_group": group}
                    self.assertEqual(POLICY.requires_scan("merge_group", event, REPOSITORY), required)
                    POLICY.validate_gate("merge_group", event, REPOSITORY, "success", str(required).lower(),
                                         "success" if required else "skipped", group["head_sha"], group["head_sha"])
                    if required:
                        for scan in ("failure", "cancelled", "skipped", "", "neutral"):
                            with self.assertRaises(ValueError):
                                POLICY.validate_gate("merge_group", event, REPOSITORY, "success", "true",
                                                     scan, group["head_sha"], group["head_sha"])
                        for live, workflow in (("d" * 40, "c" * 40), ("c" * 40, "d" * 40), (None, "c" * 40)):
                            with self.assertRaises(ValueError):
                                POLICY.validate_gate("merge_group", event, REPOSITORY, "success", "true",
                                                     "success", live, workflow)
        for key, value in (("base_sha", ""), ("head_sha", "bad"), ("head_ref", "refs/heads/feature")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                POLICY.requires_scan("merge_group", {"merge_group": group | {key: value}}, REPOSITORY)
        with patch.object(POLICY, "queue_versions", side_effect=ValueError("missing manifest")), self.assertRaises(ValueError):
            POLICY.requires_scan("merge_group", {"merge_group": group}, REPOSITORY)
        group["base_ref"] = "refs/heads/feature"
        self.assertFalse(POLICY.requires_scan("merge_group", {"merge_group": group}, REPOSITORY))

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

    def test_queue_cannot_green_a_different_release_publication_tree(self):
        event = {"merge_group": {"base_sha": "b" * 40, "base_ref": "refs/heads/main"}}
        pr = release_pr()
        POLICY.validate_queue_release_source(event, REPOSITORY, [pr], "a" * 40, "a" * 40)
        for prs, tree, group_tree in (([], None, "a" * 40), ([pr, pr], "a" * 40, "a" * 40),
                                     ([pr], "d" * 40, "a" * 40), ([pr], None, "a" * 40),
                                     ([pr | {"state": "closed"}], "a" * 40, "a" * 40)):
            with self.assertRaises(ValueError):
                POLICY.validate_queue_release_source(event, REPOSITORY, prs, tree, group_tree)
        pr = deepcopy(pr)
        pr["base"]["sha"] = "e" * 40
        POLICY.validate_queue_release_source(event, REPOSITORY, [pr], "a" * 40, "a" * 40)
        pr["base"]["ref"] = "release/1.4"
        with self.assertRaises(ValueError):
            POLICY.validate_queue_release_source(event, REPOSITORY, [pr], "a" * 40, "a" * 40)

    def test_skipped_pr_scan_still_requires_a_consistent_successful_gate(self):
        args = dict(event_name="pull_request", event={"pull_request": release_pr()},
                    repository=REPOSITORY, classify_result="success", decision="false",
                    scan_result="skipped", workflow_sha="c" * 40)
        POLICY.validate_gate(**args)
        for field, values in (("classify_result", ("failure", "cancelled", "")),
                              ("decision", ("true", "", "unknown")),
                              ("scan_result", ("success", "failure", "cancelled", ""))):
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    POLICY.validate_gate(**(args | {field: value}))

    def test_manual_pass_requires_an_explicit_successful_classification(self):
        args = dict(event_name="workflow_dispatch", event={}, repository=REPOSITORY,
                    classify_result="success", decision="false", scan_result="skipped")
        POLICY.validate_gate(**args)
        with self.assertRaises(ValueError):
            POLICY.validate_gate(**(args | {"decision": ""}))

    def run_gate(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            event = root / "event.json"
            event.write_text(json.dumps({"pull_request": release_pr()}))
            gh = root / "gh"
            gh.write_text("#!/bin/sh\nexit 23\n")
            gh.chmod(0o755)
            env = os.environ | {"PATH": f"{root}:{os.environ['PATH']}",
                "GITHUB_EVENT_PATH": str(event), "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_SHA": "c" * 40,
                "CLASSIFY_RESULT": "success", "SCAN_REQUIRED": "false", "SCAN_RESULT": "skipped"}
            return subprocess.run(["python3", str(SCRIPTS / "release-image-policy.py"), "gate"],
                env=env | overrides, text=True, capture_output=True)

    def test_pr_gate_cli_needs_no_scan_evidence_or_live_merge_candidate(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotEqual(self.run_gate(SCAN_RESULT="failure").returncode, 0)
        self.assertNotEqual(self.run_gate(SCAN_REQUIRED="true").returncode, 0)


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
        reuse = source.split("  reuse-image:\n", 1)[1].split("  build-image:\n", 1)[0]
        self.assertIn("!startsWith(inputs.checkout_ref, 'platform-v')", reuse)
        checkout = step_source(source.split("  merge-manifests:\n", 1)[1], "Checkout repository")
        self.assertIn("inputs.checkout_ref", checkout)

    def test_executing_pull_request_runs_are_not_cancelled_by_a_sibling_event(self):
        # Release Please fires `synchronize` and `edited` for one head; an
        # executing run that gets cancelled leaves failed gate contexts on
        # that commit. A merely pending sibling may still be replaced.
        source = (ROOT / ".github/workflows/docker-image-scanning.yml").read_text()
        concurrency = source.split("\nconcurrency:\n", 1)[1].split("\njobs:\n", 1)[0]
        self.assertIn("cancel-in-progress: ${{ github.event_name != 'pull_request' }}", concurrency)
        self.assertNotIn("cancel-in-progress: true", concurrency)

    def test_release_security_gate_is_always_run_and_contexts_depend_on_its_result(self):
        source = (ROOT / ".github/workflows/docker-image-scanning.yml").read_text()
        gate = source.split("  release-image-security:\n", 1)[1].split("  required-contexts:\n", 1)[0]
        self.assertIn("if: ${{ always() }}", gate)
        self.assertIn("needs: [classify, scan-release-images]", gate)
        for job in ("required-contexts", "legacy-required-context"):
            section = re.search(rf"^  {job}:\n(.*?)(?=^  [\w-]+:|\Z)", source, re.M | re.S).group(1)
            self.assertIn("if: ${{ always() }}", section)
            self.assertIn("needs: [release-image-security]", section)
            for result in ("success", "failure", "cancelled", "skipped", ""):
                command = section.split("        run: ", 1)[1].splitlines()[0]
                completed = subprocess.run(["bash", "-e", "-c", command],
                    env=os.environ | {"RESULT": result})
                self.assertEqual(completed.returncode == 0, result == "success")
        e2e = (ROOT / ".github/workflows/platform-e2e-tests.yml").read_text()
        self.assertNotIn(".github/actions/scan-docker-image", e2e)
        self.assertNotIn("run-docker-scan", source)


if __name__ == "__main__":
    unittest.main()
