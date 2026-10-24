"""Exercise retained image selection across suite failures and registry cleanup."""

import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest
import zipfile


SCRIPTS = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("byte_scan_inputs", SCRIPTS / "platform-byte-scan-inputs.py")
INPUTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INPUTS)
NOW = dt.datetime(2026, 10, 24, 4, 17, tzinfo=dt.timezone.utc)
REPO = "example/project"


def stamp(days=0):
    return (NOW - dt.timedelta(days=days)).isoformat()


def fixture(identifier=1, **overrides):
    sha = f"{identifier:040x}"
    artifact = {"id": identifier, "name": INPUTS.ARTIFACT, "expired": False,
                "created_at": stamp(identifier / 24),
                "workflow_run": {"id": identifier, "head_branch": "main", "head_sha": sha}}
    run = {"id": identifier, "created_at": stamp(identifier / 24),
           "path": ".github/workflows/platform-e2e-tests.yml", "head_sha": sha,
           "event": "schedule", "head_branch": "main", "conclusion": "failure",
           "repository": {"full_name": REPO}} | overrides
    value = {"schema": 1, "source_sha": sha, "platform": "linux/amd64",
             "full": f"{INPUTS.IMAGE}@sha256:{identifier:064x}",
             "slim": f"{INPUTS.IMAGE}@sha256:{identifier + 100:064x}"}
    return artifact, run, value


class RetainedImageTests(unittest.TestCase):
    def select(self, fixtures, resolve=lambda ref: ref):
        def request(path, binary=False):
            if "?name=" in path:
                return {"artifacts": [item[0] for item in fixtures]}
            identifier = int(path.split("/")[-2 if binary else -1])
            _, run, value = next(item for item in fixtures if item[0]["id"] == identifier)
            if not binary:
                return run
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w") as files:
                files.writestr(INPUTS.FILENAME, json.dumps(value))
            return archive.getvalue()
        return INPUTS.select(REPO, "main", request=request, resolve_image=resolve, now=NOW)

    def test_completed_image_build_remains_scannable_when_suite_fails_or_is_running(self):
        for conclusion in ("success", "failure", "cancelled", None):
            with self.subTest(conclusion=conclusion):
                selected = self.select([fixture(conclusion=conclusion)])
                self.assertEqual(selected["source_sha"], f"{1:040x}")
                self.assertEqual(selected["run_id"], 1)

    def test_registry_cleanup_selects_the_next_available_complete_pair_by_digest(self):
        calls = []
        def resolve(ref):
            calls.append(ref)
            if ref == fixture()[2]["slim"]:
                raise subprocess.CalledProcessError(1, "docker")
            return ref
        selected = self.select([fixture(2), fixture(1)], resolve)
        self.assertEqual(selected["run_id"], 2)
        self.assertEqual(calls, [fixture(1)[2]["full"], fixture(1)[2]["slim"],
                                 fixture(2)[2]["full"], fixture(2)[2]["slim"]])

    def test_expired_stale_future_wrong_branch_and_untrusted_records_are_ineligible(self):
        variants = []
        for field, value in (("expired", True), ("created_at", stamp(8)), ("created_at", stamp(-1))):
            item = fixture()
            item[0][field] = value
            variants.append(item)
        item = fixture()
        item[0]["workflow_run"]["head_branch"] = "feature"
        variants.append(item)
        for overrides in ({"event": "pull_request"}, {"event": "merge_group"},
                          {"path": ".github/workflows/other.yml"}, {"head_sha": "b" * 40},
                          {"created_at": stamp(8)}, {"repository": {"full_name": "other/repo"}}):
            variants.append(fixture(**overrides))
        for item in variants:
            with self.subTest(item=item), self.assertRaisesRegex(ValueError, "No available"):
                self.select([item])

    def test_missing_artifacts_and_missing_image_pairs_fail_without_floating_fallback(self):
        with self.assertRaisesRegex(ValueError, "No available"):
            self.select([])
        def missing(ref):
            self.assertIn("@sha256:", ref)
            raise subprocess.CalledProcessError(1, "docker")
        with self.assertRaisesRegex(ValueError, "No available"):
            self.select([fixture()], missing)

    def test_malformed_cross_revision_cross_registry_and_incomplete_records_fail_closed(self):
        for changes in ({"source_sha": "b" * 40}, {"full": INPUTS.IMAGE + ":latest"},
                        {"slim": "other/image@sha256:" + "a" * 64}, {"slim": ""},
                        {"platform": "linux/arm64"}, {"schema": 2}):
            item = fixture()
            item[2].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.select([item])

    def test_explicit_sha_requires_both_exact_image_variants(self):
        calls = []
        def resolve(ref):
            calls.append(ref)
            return fixture()[2]["slim" if ref.endswith("-slim") else "full"]
        value = INPUTS.record("a" * 40, resolve)
        self.assertEqual(calls, [f"{INPUTS.IMAGE}:{'a' * 40}-e2e", f"{INPUTS.IMAGE}:{'a' * 40}-e2e-slim"])
        self.assertEqual(INPUTS.validate_record(value, "a" * 40), value)
        for sha in ("", "main", "a" * 39):
            with self.assertRaises(ValueError):
                INPUTS.record(sha, resolve)

    def test_cli_missing_artifacts_fails_before_writing_any_scan_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gh = root / "gh"
            gh.write_text('#!/bin/sh\nprintf \'{"artifacts":[]}\\n\'\n')
            gh.chmod(0o755)
            output = root / "output"
            result = subprocess.run(["python3", str(SCRIPTS / "platform-byte-scan-inputs.py"), "select"],
                env=os.environ | {"PATH": f"{root}:{os.environ['PATH']}", "REPOSITORY": REPO,
                    "SOURCE_BRANCH": "main", "INPUT_IMAGE_SHA": "", "GITHUB_OUTPUT": str(output)},
                text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("No available", result.stderr)
            self.assertFalse(output.exists())


class ByteScanActionTests(unittest.TestCase):
    def pull(self, **overrides):
        source = (SCRIPTS.parent / "actions/scan-platform-image-bytes/action.yml").read_text()
        section = source.split("    - name: Resolve, pull, and pin exact image bytes\n", 1)[1]
        script = textwrap.dedent(section.split("      run: |\n", 1)[1].split("    - name:", 1)[0])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            resolver = root / ".github/scripts/resolve-attested-image.sh"
            resolver.parent.mkdir(parents=True)
            resolver.write_text('''#!/bin/bash
if [ "${MISSING_IMAGE:-}" = 1 ]; then exit 23; fi
if [[ "$1" == *@* ]]; then echo "$1"; else
  if [[ "$1" == *-slim ]]; then printf '%s@sha256:%064d\\n' "$IMAGE_REPO" 2;
  else printf '%s@sha256:%064d\\n' "$IMAGE_REPO" 1; fi
fi
''')
            docker = root / "docker"
            docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as calls: calls.write(json.dumps(args) + '\\n')
if args[0] == 'pull':
    assert args[:3] == ['pull', '--platform', 'linux/amd64']
    if os.environ.get('ARM64_ONLY') == '1': sys.exit(1)
elif args[:2] == ['image', 'inspect']:
    print('sha256:' + ('a' if args[2].endswith('1') else 'b') * 64)
else: sys.exit(64)
''')
            docker.chmod(0o755)
            output, calls = root / "output", root / "calls"
            result = subprocess.run(["bash", "-euo", "pipefail", "-c", script], cwd=root,
                env=os.environ | {"PATH": f"{root}:{os.environ['PATH']}", "IMAGE_REPO": INPUTS.IMAGE,
                    "IMAGE_SHA": "a" * 40, "FULL_IMAGE": f"{INPUTS.IMAGE}@sha256:{1:064x}",
                    "SLIM_IMAGE": f"{INPUTS.IMAGE}@sha256:{2:064x}", "CALLS": str(calls),
                    "GITHUB_OUTPUT": str(output)} | overrides, text=True, capture_output=True)
            return result, output.read_text() if output.exists() else "", (
                [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else [])

    def test_retained_and_explicit_sha_inputs_scan_pulled_local_ids_on_amd64(self):
        for overrides in ({}, {"FULL_IMAGE": "", "SLIM_IMAGE": ""}):
            result, output, calls = self.pull(**overrides)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output, f"full=local://sha256:{'a' * 64}\nslim=local://sha256:{'b' * 64}\n")
            self.assertTrue(all("@sha256:" in args[3] for args in calls if args[0] == "pull"))

    def test_partial_mutable_cross_registry_missing_and_wrong_arch_images_never_emit_outputs(self):
        for overrides in ({"SLIM_IMAGE": ""}, {"FULL_IMAGE": INPUTS.IMAGE + ":latest"},
                          {"FULL_IMAGE": "other/image@sha256:" + "a" * 64},
                          {"MISSING_IMAGE": "1"}, {"ARM64_ONLY": "1"}, {"IMAGE_SHA": "main"}):
            with self.subTest(overrides=overrides):
                result, output, _ = self.pull(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output, "")


class AttestedDigestResolverTests(unittest.TestCase):
    def resolve(self, *, pinned=True, platforms=1, corrupt=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            platform_digest, attestation_digest = "sha256:" + "a" * 64, "sha256:" + "b" * 64
            sbom = json.dumps({"predicateType": "https://spdx.dev/Document",
                "subject": [{"digest": {"sha256": "a" * 64}}],
                "predicate": {"spdxVersion": "SPDX-2.3", "packages": [{}] * 1000}})
            blob_digest = "sha256:" + hashlib.sha256(sbom.encode()).hexdigest()
            index = json.dumps({"manifests": [
                {"digest": platform_digest, "platform": {"os": "linux", "architecture": "amd64"}}
                for _ in range(platforms)] + [{"digest": attestation_digest,
                    "platform": {"os": "unknown", "architecture": "unknown"},
                    "annotations": {"vnd.docker.reference.type": "attestation-manifest",
                                    "vnd.docker.reference.digest": platform_digest}}]})
            digest = "sha256:" + hashlib.sha256(index.encode()).hexdigest()
            (root / "index").write_text(index)
            (root / "attestation").write_text(json.dumps({"layers": [{"digest": blob_digest,
                "annotations": {"in-toto.io/predicate-type": "https://spdx.dev/Document"}}]}))
            (root / "sbom").write_text("corrupt" if corrupt else sbom)
            (root / "docker").write_text('''#!/usr/bin/env python3
import os, pathlib, sys
ref = sys.argv[4]
assert ref.startswith(os.environ['EXPECTED_REPO'] + ('@' if '@' in ref else ':')), ref
name = 'attestation' if ref.endswith('b' * 64) else 'index'
sys.stdout.write((pathlib.Path(os.environ['FIXTURE']) / name).read_text())
''')
            (root / "gcloud").write_text("#!/bin/sh\nexit 1\n")
            (root / "curl").write_text('''#!/usr/bin/env python3
import os, pathlib, sys
assert sys.argv[-1].startswith('https://' + os.environ['EXPECTED_REPO'].split('/')[0] + '/v2/'), sys.argv[-1]
assert '@' not in sys.argv[-1], sys.argv[-1]
pathlib.Path(sys.argv[sys.argv.index('--output') + 1]).write_text((pathlib.Path(os.environ['FIXTURE']) / 'sbom').read_text())
''')
            for command in ("docker", "gcloud", "curl"):
                (root / command).chmod(0o755)
            reference = INPUTS.IMAGE + ("@" + digest if pinned else ":" + "a" * 40 + "-e2e")
            result = subprocess.run(["bash", str(SCRIPTS / "resolve-attested-image.sh"), reference],
                env=os.environ | {"PATH": f"{root}:{os.environ['PATH']}", "FIXTURE": str(root),
                    "EXPECTED_REPO": INPUTS.IMAGE}, text=True, capture_output=True)
            return result, INPUTS.IMAGE + "@" + digest

    def test_tags_and_retained_digests_validate_the_same_bound_sbom(self):
        for pinned in (False, True):
            result, expected = self.resolve(pinned=pinned)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), expected)

    def test_multiarch_missing_platform_and_corrupt_inventory_fail_closed(self):
        for args in ({"platforms": 0}, {"platforms": 2}, {"corrupt": True}):
            with self.subTest(args=args):
                result, _ = self.resolve(**args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
