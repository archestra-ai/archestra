"""Adversarial fixtures for complete, fresh image/architecture scan evidence."""

import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("candidate", ROOT / ".github/scripts/release-candidate.py")
CANDIDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CANDIDATE)
IDENTITY = {"source_sha": "a" * 40, "source_tree": "b" * 40,
            "run_id": "12", "run_attempt": "2", "repository": "example/project"}
NOW = dt.datetime.now(dt.timezone.utc)


def record(image="platform", arch="amd64"):
    return {"schema": 1, **IDENTITY, "image": image, "arch": arch,
            "created_at": NOW.isoformat(), "scan_result": "success", "version": "1.4.1",
            "previous_image": "docker.io/archestra/platform@sha256:" + "3" * 64,
            "image_id": "sha256:" + "1" * 64, "archive_digest": "sha256:" + "2" * 64}


class EvidenceTests(unittest.TestCase):
    def validate(self, records):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            for index, value in enumerate(records):
                (directory / f"{index}.json").write_text(json.dumps(value))
            with patch.object(CANDIDATE, "identity", return_value=IDENTITY), patch.object(
                CANDIDATE, "build_inputs", return_value={key: record()[key] for key in ("version", "previous_image")}
            ):
                CANDIDATE.validate_evidence(directory, {"include": [{"image": "platform"}]})

    def test_exact_complete_pair_passes_and_no_partial_set_can_pass(self):
        values = [record(arch=arch) for arch in ("amd64", "arm64")]
        self.validate(values)
        for bad in ([], values[:1], values[1:], values + [values[0]], values + [record("extra")]):
            with self.subTest(records=bad), self.assertRaises(ValueError):
                self.validate(bad)

    def test_all_unsuccessful_or_missing_scan_results_fail_even_with_other_green_legs(self):
        for result in ("failure", "skipped", "cancelled", "neutral", "", None):
            with self.subTest(result=result), self.assertRaises(ValueError):
                self.validate([record(), record(arch="arm64") | {"scan_result": result}])

    def test_stale_revision_tree_workflow_attempt_repository_and_inputs_fail(self):
        for key, value in ({"source_sha": "c" * 40, "source_tree": "d" * 40, "run_id": "11",
                            "run_attempt": "1", "repository": "other/project", "version": "1.4.0",
                            "previous_image": "docker.io/archestra/platform:latest",
                            "arch": "ppc64le", "image_id": "mutable", "archive_digest": ""}).items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate([record(), record(arch="arm64") | {key: value}])
        for offset in (dt.timedelta(hours=-25), dt.timedelta(minutes=5)):
            with self.assertRaises(ValueError):
                self.validate([record(), record(arch="arm64") | {"created_at": (NOW + offset).isoformat()}])

    def test_missing_evidence_directory_and_symlink_fail_closed(self):
        with patch.object(CANDIDATE, "identity", return_value=IDENTITY), tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            with self.assertRaises(OSError):
                CANDIDATE.validate_evidence(directory / "missing", {"include": [{"image": "platform"}]})
            source = directory / "source.json"
            source.write_text(json.dumps(record()))
            evidence = directory / "evidence"
            evidence.mkdir()
            (evidence / "link.json").symlink_to(source)
            with self.assertRaisesRegex(ValueError, "Unexpected candidate evidence file"):
                CANDIDATE.validate_evidence(evidence, {"include": [{"image": "platform"}]})

    def test_loaded_image_config_and_architecture_must_match(self):
        image_id = record()["image_id"]
        good = {"Id": image_id, "Os": "linux", "Architecture": "arm64"}
        for row in (good, good | {"Architecture": "amd64"}, good | {"Id": "sha256:" + "f" * 64}, good | {"Os": "windows"}):
            with patch.object(CANDIDATE, "command", return_value=json.dumps([row])):
                if row == good:
                    CANDIDATE.inspect_image(image_id, image_id, "arm64")
                else:
                    with self.assertRaises(ValueError):
                        CANDIDATE.inspect_image(image_id, image_id, "arm64")


class BuildInputsTests(unittest.TestCase):
    def inputs(self, manifests, image="platform", arch="arm64"):
        manifest = json.dumps({"platform": "1.4.1"})
        with patch.object(Path, "read_text", return_value=manifest), patch.object(
            CANDIDATE, "command", side_effect=["platform-v1.4.0", "platform-v1.4.0", json.dumps({"manifests": manifests})]
        ):
            return CANDIDATE.build_inputs(image, arch)

    def test_previous_assets_resolve_separately_for_both_architectures(self):
        rows = [{"digest": "sha256:" + str(i + 1) * 64,
                 "platform": {"os": "linux", "architecture": arch}}
                for i, arch in enumerate(("amd64", "arm64"))]
        for i, arch in enumerate(("amd64", "arm64")):
            self.assertEqual(self.inputs(rows, arch=arch), {"version": "1.4.1",
                "previous_image": "docker.io/archestra/platform@sha256:" + str(i + 1) * 64})
        for rows in ([], rows[:1], rows[1:] * 2, [rows[1] | {"digest": "mutable"}]):
            with self.assertRaises(ValueError):
                self.inputs(rows)

    def test_companions_use_release_version_and_initial_release_needs_no_previous_image(self):
        with patch.object(Path, "read_text", return_value='{"platform":"1.5.0-rc.7"}'), patch.object(
            CANDIDATE, "command", return_value=""
        ) as command:
            self.assertEqual(CANDIDATE.build_inputs("sandbox-base", "amd64"),
                             {"version": "1.5.0-rc.7", "previous_image": ""})
            command.assert_not_called()
            self.assertEqual(CANDIDATE.build_inputs("platform", "arm64")["previous_image"], "")
        with self.assertRaises(ValueError):
            CANDIDATE.build_inputs("platform", "ppc64le")


class AssetExtractionTests(unittest.TestCase):
    def test_release_asset_pull_create_and_copy_errors_block_the_build(self):
        action = (ROOT / ".github/actions/build-docker-image/action.yml").read_text()
        section = action.split("    - name: Extract previous version static assets\n", 1)[1].split("      env:\n", 1)[0]
        script = textwrap.dedent(section.split("      run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            docker = root / "docker"
            docker.write_text('#!/bin/sh\n[ "$1" != "$FAIL_STEP" ] || exit 23\n[ "$1" != create ] || echo container-id\nexit 0\n')
            docker.chmod(0o755)
            for step in ("none", "pull", "create", "cp"):
                result = subprocess.run(["bash", "-c", script], env=os.environ | {
                    "PATH": f"{root}:{os.environ['PATH']}", "INPUT_PREVIOUS_IMAGE": "image@sha256:digest",
                    "INPUT_CONTEXT": str(root), "REQUIRE_PREVIOUS_ASSETS": "true", "FAIL_STEP": step},
                    capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, step == "none", result.stdout + result.stderr)


class ScoutInstallerTests(unittest.TestCase):
    def test_native_archives_are_checksum_verified_and_unknown_architectures_stop(self):
        action = (ROOT / ".github/actions/scan-docker-image/action.yml").read_text()
        section = action.split("    - name: Install Docker Scout CLI\n", 1)[1].split("    - name: Docker Scout CVE Check", 1)[0]
        script = textwrap.dedent(section.split("      run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, source in {
                "uname": '#!/bin/sh\necho "$RUNNER_MACHINE"\n',
                "gh": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n',
                "sha256sum": '#!/bin/sh\ncat >> "$CALLS"\nexit "$CHECKSUM_STATUS"\n',
                "tar": '#!/bin/sh\necho EXTRACTED >> "$CALLS"\n',
            }.items():
                file = root / name
                file.write_text(source)
                file.chmod(0o755)
            for machine, expected_arch in (("x86_64", "amd64"), ("aarch64", "arm64"), ("arm64", "arm64"), ("ppc64le", None)):
                for status in ("0", "1"):
                    calls = root / "calls"
                    calls.unlink(missing_ok=True)
                    result = subprocess.run(["bash", "-c", script], env=os.environ | {
                        "PATH": f"{root}:{os.environ['PATH']}", "RUNNER_TEMP": temp,
                        "SCOUT_VERSION": "1.24.0", "SCOUT_AMD64_SHA256": "AMD64-CHECKSUM",
                        "SCOUT_ARM64_SHA256": "ARM64-CHECKSUM", "RUNNER_MACHINE": machine,
                        "CHECKSUM_STATUS": status, "CALLS": str(calls)}, capture_output=True, text=True)
                    logged = calls.read_text() if calls.exists() else ""
                    self.assertEqual(result.returncode == 0, expected_arch is not None and status == "0")
                    if expected_arch:
                        self.assertIn(f"linux_{expected_arch}.tar.gz", logged)
                        self.assertIn(f"{expected_arch.upper()}-CHECKSUM", logged)
                    else:
                        self.assertEqual(logged, "")
                    self.assertEqual("EXTRACTED" in logged, expected_arch is not None and status == "0")


class GateIntegrationTests(unittest.TestCase):
    def test_real_gate_cli_needs_the_complete_current_inventory_even_when_jobs_are_green(self):
        policy_path = ROOT / ".github/scripts/release-image-policy.py"
        spec = importlib.util.spec_from_file_location("gate", policy_path)
        policy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(policy)
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            def git(*args):
                return subprocess.check_output(["git", "-C", temp, *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "CI fixture")
            git("config", "user.email", "fixture@example.invalid")
            manifest = directory / ".github/release-please/.release-please-manifest.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text('{"platform":"1.4.0"}')
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            manifest.write_text('{"platform":"1.4.1"}')
            git("commit", "-qam", "release")
            sha, tree = git("rev-parse", "HEAD"), git("rev-parse", "HEAD^{tree}")
            pr = {"number": 42, "state": "open", "merge_commit_sha": sha,
                  "head": {"ref": "release-please--branches--main--components--platform", "sha": sha,
                           "repo": {"full_name": IDENTITY["repository"]}},
                  "base": {"ref": "main", "sha": base, "repo": {"full_name": IDENTITY["repository"]}}}
            (directory / "current.json").write_text(json.dumps(pr))
            (directory / "event.json").write_text(json.dumps({"pull_request": pr}))
            gh = directory / "gh"
            gh.write_text(f'#!/bin/sh\ncat "{directory}/current.json"\n')
            gh.chmod(0o755)
            evidence = directory / "evidence"
            evidence.mkdir()
            for row in policy.candidate_matrix(ROOT)["include"]:
                for arch in ("amd64", "arm64"):
                    value = record(row["image"], arch) | {"source_sha": sha, "source_tree": tree,
                                                          "previous_image": ""}
                    (evidence / f"{row['image']}-{arch}.json").write_text(json.dumps(value))
            env = os.environ | {"PATH": f"{directory}:{os.environ['PATH']}",
                "GITHUB_SHA": sha, "GITHUB_RUN_ID": "12", "GITHUB_RUN_ATTEMPT": "2",
                "GITHUB_REPOSITORY": IDENTITY["repository"], "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_EVENT_PATH": str(directory / "event.json"), "EVIDENCE_DIR": str(evidence),
                "CLASSIFY_RESULT": "success", "SCAN_REQUIRED": "true", "SCAN_RESULT": "success"}
            def gate(overrides=None):
                return subprocess.run(["python3", str(policy_path), "gate"], cwd=directory,
                                      env=env | (overrides or {}), capture_output=True, text=True, timeout=10)
            result = gate()
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            for scan in ("failure", "skipped", "cancelled", "", "neutral"):
                self.assertNotEqual(gate({"SCAN_RESULT": scan}).returncode, 0)
            self.assertNotEqual(gate({"GITHUB_RUN_ATTEMPT": "3"}).returncode, 0)
            next(evidence.iterdir()).unlink()
            result = gate()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Incomplete scan inventory", result.stderr)


if __name__ == "__main__":
    unittest.main()
