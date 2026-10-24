"""Non-publishing fixtures for selecting, relaying and loading scanned bytes."""

from copy import deepcopy
import datetime as dt
import fnmatch
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("handoff", ROOT / ".github/scripts/release-handoff.py")
HANDOFF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HANDOFF)
NOW = dt.datetime.now(dt.timezone.utc)
TIME = NOW.isoformat()
REPO = "example/project"
SOURCE, RELEASE, TREE = "a" * 40, "b" * 40, "c" * 40
MATRIX = {"include": [{"image": "sandbox-base"}]}


class HandoffFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run = {"id": 12, "run_attempt": 2, "head_sha": SOURCE, "path": HANDOFF.WORKFLOW,
                    "event": "merge_group", "head_branch": "gh-readonly-queue/release/1.4/pr-42-test",
                    "created_at": TIME, "status": "completed", "conclusion": "success",
                    "repository": {"full_name": REPO}, "head_repository": {"full_name": REPO}}
        self.index = {"schema": 1, "repository": REPO, "branch": "release/1.4", "source_sha": SOURCE,
                      "source_tree": TREE, "run_id": "12", "run_attempt": "2", "created_at": TIME, "records": []}
        self.artifacts = []
        self.archives = {}
        self.calls = []
        for i, arch in enumerate(("amd64", "arm64")):
            payload = f"deterministic harmless {arch} image fixture".encode()
            record = {key: self.index[key] for key in ("repository", "source_sha", "source_tree", "run_id", "run_attempt")}
            record.update(schema=1, created_at=TIME, image="sandbox-base", arch=arch, version="1.4.1",
                          previous_image="", image_id="sha256:" + str(i + 1) * 64,
                          archive_digest="sha256:" + hashlib.sha256(payload).hexdigest())
            self.artifact(f"release-candidate-sandbox-base-{arch}-2", {"build.json": json.dumps(record), "image.tar": payload})
            self.index["records"].append(record | {"scan_result": "success"})
        self.index_artifact()
        self.jobs = [{"name": "Release Image Security", "status": "completed", "conclusion": "success"},
                     *[{"name": f"Scan release candidate (sandbox-base, {arch})", "status": "completed", "conclusion": "success"}
                       for arch in ("amd64", "arm64")]]
        self.runs = [self.run]

    def artifact(self, name, files):
        artifact_id = len(self.archives) + 1
        archive = self.root / f"{artifact_id}.zip"
        with zipfile.ZipFile(archive, "w") as output:
            for file, data in files.items():
                output.writestr(file, data)
        value = {"id": artifact_id, "name": name, "expired": False, "created_at": TIME,
                 "digest": HANDOFF.digest(archive)}
        self.artifacts.append(value)
        self.archives[artifact_id] = archive
        return value

    def index_artifact(self):
        self.artifacts = [row for row in self.artifacts if not row["name"].startswith("release-candidate-index-")]
        return self.artifact("release-candidate-index-2", {"release-candidate-index.json": json.dumps(self.index)})

    def request(self, path):
        self.calls.append(path)
        if "/git/commits/" in path:
            return {"tree": {"sha": TREE}}
        if "/workflows/" in path:
            return {"workflow_runs": self.runs}
        if "/jobs?" in path:
            return {"jobs": self.jobs}
        if "/artifacts?" in path:
            return {"artifacts": self.artifacts}
        raise AssertionError(path)

    def fetch(self, repository, artifact, destination):
        self.assertEqual(repository, REPO)
        shutil.copyfile(self.archives[artifact["id"]], destination)
        if HANDOFF.digest(destination) != artifact["digest"]:
            raise ValueError("GitHub artifact archive checksum mismatch")

    def select(self):
        return HANDOFF.select(REPO, "release/1.4", RELEASE, "1.4.1", MATRIX, self.request, self.fetch, NOW)

    def test_synthetic_and_final_commits_with_the_same_tree_can_reuse_both_archives(self):
        selection = self.select()
        self.assertNotEqual(selection["release_sha"], selection["index"]["source_sha"])
        self.assertEqual(selection["release_tree"], selection["index"]["source_tree"])
        for arch in ("amd64", "arm64"):
            directory = self.root / arch
            HANDOFF.relay(selection, "sandbox-base", arch, directory, self.fetch)
            self.assertEqual(HANDOFF.digest(directory / "image.tar"), HANDOFF.selected_record(selection, "sandbox-base", arch)["archive_digest"])
            self.assertFalse(directory.with_suffix(".zip").exists())

    def test_latest_failure_pending_or_cancelled_run_cannot_fall_back_to_older_green(self):
        for status, result in (("completed", "failure"), ("completed", "cancelled"), ("in_progress", None)):
            with self.subTest(status=status, result=result):
                self.runs = [self.run, self.run | {"id": 13, "status": status, "conclusion": result}]
                with self.assertRaisesRegex(ValueError, "Latest matching queue scan"):
                    self.select()

    def test_other_events_workflows_repositories_branches_and_expired_runs_are_rejected(self):
        for change in ({"event": "pull_request"}, {"event": "workflow_dispatch"}, {"path": "other.yml"},
                       {"head_branch": "gh-readonly-queue/main/pr-42"}, {"repository": {"full_name": "other/project"}},
                       {"head_repository": {"full_name": "other/project"}}, {"created_at": (NOW - dt.timedelta(days=2)).isoformat()}):
            with self.subTest(change=change):
                self.runs = [self.run | change]
                with self.assertRaisesRegex(ValueError, "No fresh scanned"):
                    self.select()

    def test_failed_skipped_missing_and_duplicate_scan_legs_or_gate_block_promotion(self):
        good = deepcopy(self.jobs)
        for result in ("failure", "skipped", "cancelled", "neutral", None):
            for i in (0, 1, 2):
                self.jobs = deepcopy(good)
                self.jobs[i]["conclusion"] = result
                with self.subTest(result=result, job=i), self.assertRaises(ValueError):
                    self.select()
        for jobs in (good[:-1], good + [good[0]], good + [good[1]]):
            self.jobs = jobs
            with self.assertRaises(ValueError):
                self.select()

    def test_index_revision_attempt_version_inventory_and_fixture_binding_fail_closed(self):
        good = deepcopy(self.index)
        for key, value in {"fixture": True, "source_sha": "d" * 40, "source_tree": "d" * 40,
                           "run_attempt": "1", "run_id": "11", "repository": "other/project",
                           "branch": "main", "created_at": (NOW + dt.timedelta(minutes=2)).isoformat()}.items():
            self.index = deepcopy(good) | {key: value}
            self.index_artifact()
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.select()
        for key, value in {"scan_result": "skipped", "arch": "ppc64le", "version": "1.4.0",
                           "source_sha": "e" * 40, "archive_digest": "mutable"}.items():
            self.index = deepcopy(good)
            self.index["records"][0][key] = value
            self.index_artifact()
            with self.subTest(record_key=key), self.assertRaises(ValueError):
                self.select()
        for records in ([], good["records"][:1], good["records"] + [good["records"][0]]):
            self.index = deepcopy(good) | {"records": records}
            self.index_artifact()
            with self.assertRaises(ValueError):
                self.select()

    def test_missing_expired_duplicate_or_unbound_archives_block_before_relay(self):
        good = deepcopy(self.artifacts)
        for artifacts in (good[1:], good + [good[0]], [good[0] | {"expired": True}, *good[1:]],
                          [good[0] | {"digest": ""}, *good[1:]]):
            self.artifacts = artifacts
            with self.assertRaises(ValueError):
                self.select()

    def test_archive_tampering_metadata_changes_extra_paths_and_symlinks_are_rejected(self):
        selection = self.select()
        row = HANDOFF.selected_record(selection, "sandbox-base", "amd64")
        archive = self.archives[row["artifact"]["id"]]
        archive.write_bytes(archive.read_bytes() + b"tampering")
        with self.assertRaisesRegex(ValueError, "checksum"):
            HANDOFF.relay(selection, "sandbox-base", "amd64", self.root / "bad", self.fetch)
        for names in ({"../build.json": "{}", "image.tar": b"x"},
                      {"build.json": "{}", "image.tar": b"x", "extra": "x"}):
            meta = self.artifact("test", names)
            with self.assertRaises(ValueError):
                HANDOFF.unpack(self.archives[meta["id"]], self.root / "bad", ["build.json", "image.tar"])
        meta = self.artifact("test", {"build.json": "{}", "image.tar": b"wrong bytes"})
        row["artifact"] = meta
        with self.assertRaisesRegex(ValueError, "bytes/metadata"):
            HANDOFF.relay(selection, "sandbox-base", "amd64", self.root / "wrong", self.fetch)

    def test_loaded_bytes_match_the_release_and_no_build_or_registry_command_runs_in_this_fixture(self):
        selection = self.select()
        directory = self.root / "loaded"
        HANDOFF.relay(selection, "sandbox-base", "arm64", directory, self.fetch)
        record = HANDOFF.selected_record(selection, "sandbox-base", "arm64")
        candidate = HANDOFF.load_module("release-candidate")
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": REPO, "EXPECTED_VERSION": "1.4.1"}), patch.object(
            HANDOFF, "command", side_effect=[RELEASE, TREE]
        ), patch.object(HANDOFF, "load_module", return_value=candidate), patch.object(
            candidate, "build_inputs", return_value={"version": "1.4.1", "previous_image": ""}
        ), patch.object(candidate, "inspect_image") as inspect, patch.object(HANDOFF.subprocess, "run") as run:
            self.assertEqual(HANDOFF.verify_loaded(selection, "sandbox-base", "arm64", directory), record)
            run.assert_called_once_with(["docker", "load", "--input", str(directory / "image.tar")], check=True)
            inspect.assert_called_once_with(record["image_id"], record["image_id"], "arm64")
        (directory / "image.tar").write_bytes(b"changed in same-run transfer")
        with patch.dict(os.environ, {"GITHUB_REPOSITORY": REPO, "EXPECTED_VERSION": "1.4.1"}), patch.object(
            HANDOFF, "command", side_effect=[RELEASE, TREE]
        ), patch.object(HANDOFF.subprocess, "run") as run, self.assertRaisesRegex(ValueError, "bytes changed"):
            HANDOFF.verify_loaded(selection, "sandbox-base", "arm64", directory)
        run.assert_not_called()

    def test_registry_config_mismatch_stops_before_index_or_final_version_tag(self):
        record = self.index["records"][0]
        image = "docker.io/archestra/platform"
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "14", "GITHUB_RUN_ATTEMPT": "1"}), patch.object(
            HANDOFF, "command", side_effect=[json.dumps([image + "@sha256:" + "f" * 64]),
                                              json.dumps({"config": {"digest": "sha256:" + "0" * 64}})]
        ), patch.object(HANDOFF.subprocess, "run") as run, self.assertRaisesRegex(ValueError, "Registry image config"):
            HANDOFF.push(record, image, "amd64")
        self.assertEqual([call.args[0][:2] for call in run.call_args_list], [["docker", "tag"], ["docker", "push"]])
        self.assertTrue(all("candidate-14-1-amd64" in str(call) for call in run.call_args_list))

    def test_promotion_keeps_the_config_identity_when_docker_hub_normalizes_names(self):
        record = self.index["records"][0]
        image = "docker.io/archestra/platform"
        for repository in (image, "archestra/platform"):
            with patch.dict(os.environ, {"GITHUB_RUN_ID": "14", "GITHUB_RUN_ATTEMPT": "1"}), patch.object(
                HANDOFF, "command", side_effect=[json.dumps([repository + "@sha256:" + "f" * 64]),
                    json.dumps({"config": {"digest": record["image_id"]}}), json.dumps({"digest": "sha256:" + "e" * 64})]
            ), patch.object(HANDOFF.subprocess, "run") as run:
                self.assertEqual(HANDOFF.push(record, image, "amd64"), "sha256:" + "e" * 64)
            self.assertEqual(run.call_count, 3)
            self.assertEqual(run.call_args_list[-1].args[0][:5], ["docker", "buildx", "imagetools", "create", "--prefer-index=true"])
            self.assertNotIn("build", [arg for call in run.call_args_list for arg in call.args[0]])


class WorkflowHandoffTests(unittest.TestCase):
    def test_fixture_dispatch_guards_every_production_step_and_confines_the_read_only_app_token(self):
        source = (ROOT / ".github/workflows/release-please.yml").read_text()
        job = source.split("  release-please:\n", 1)[1].split("  build-and-push-mcp-server-docker-image:\n", 1)[0]
        blocks = re.split(r"(?=^      - name: )", job, flags=re.M)[1:]
        exempt = {"Checkout repository", "Generate a token", "Verify non-publishing cross-run fixture with the existing App",
                  "Relay non-publishing fixture to a tokenless consumer"}
        for block in blocks:
            name = block.splitlines()[0].split("- name: ", 1)[1]
            if name not in exempt:
                condition = re.search(r"^        if: (.+)$", block, re.M)
                self.assertIsNotNone(condition, name)
                self.assertIn("!inputs.handoff-fixture", condition[1], name)
        token = next(block for block in blocks if block.startswith("      - name: Generate a token"))
        self.assertIn("permission-actions: ${{ inputs.handoff-fixture && 'read' || '' }}", token)
        self.assertIn("permission-contents: ${{ inputs.handoff-fixture && 'read' || '' }}", token)
        consumer = source.split("  verify-handoff-fixture:\n", 1)[1]
        self.assertNotIn("secrets.", consumer)
        self.assertNotIn("steps.generate-token", consumer)
        self.assertNotIn("actions:", consumer)

    def test_publishers_cannot_select_digest_or_image_artifacts_from_an_earlier_attempt(self):
        native = (ROOT / ".github/workflows/build-native-multi-arch-image.yml").read_text()
        release = (ROOT / ".github/workflows/release-please.yml").read_text()
        for source, prefix, current, stale in (
            (native, "${{ inputs.image_name }}-digests-", "platform-digests-0-2", "platform-digests-0-1"),
            (release, "release-image-", "release-image-platform-2", "release-image-platform-1"),
        ):
            pattern = next(line.split("pattern: ", 1)[1] for line in source.splitlines() if "pattern: " + prefix in line)
            pattern = pattern.replace("${{ inputs.image_name }}", "platform").replace("${{ github.run_attempt }}", "2")
            self.assertTrue(fnmatch.fnmatchcase(current, pattern))
            self.assertFalse(fnmatch.fnmatchcase(stale, pattern))

    def test_relay_inventory_matches_publishers_and_release_build_has_no_rebuild_fallback(self):
        policy = HANDOFF.load_module("release-image-policy")
        expected = {row["image"] for row in policy.candidate_matrix(ROOT)["include"]} - {"platform-slim"}
        release = (ROOT / ".github/workflows/release-please.yml").read_text()
        relay = release.split("      - name: Select the exact scanned queue artifacts\n", 1)[1].split("      - name: Create git tag for draft release", 1)[0]
        images = re.findall(r"^          image_name: ([a-z0-9-]+)$", relay, re.M)
        self.assertEqual(set(images), expected)
        self.assertEqual(len(images), len(set(images)))
        native = (ROOT / ".github/workflows/build-native-multi-arch-image.yml").read_text()
        build = native.split("      - name: Build Docker image\n", 1)[1].split("      - name:", 1)[0]
        self.assertIn("!startsWith(inputs.checkout_ref, 'platform-v')", build)
        self.assertLess(native.index("Promote exact scanned bytes without rebuilding"), native.index("Export digest"))
        self.assertLess(native.index("Scan release amd64 bytes before tagging"), native.index("Create manifest list and push"))
        self.assertLess(native.index("Scan release arm64 bytes before tagging"), native.index("Create manifest list and push"))
        relay_action = (ROOT / ".github/actions/relay-release-candidate/action.yml").read_text()
        self.assertEqual(relay_action.count("GH_TOKEN: ${{ inputs.token }}"), 2)
        # Credentials stay in the original release job; native publishers use
        # only same-run artifact downloads, with no new App secrets or scopes.
        self.assertNotIn("ARCHESTRA_RELEASER_GITHUB_APP", native)
        self.assertNotIn("actions: read", native)


if __name__ == "__main__":
    unittest.main()
