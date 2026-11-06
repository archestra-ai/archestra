"""Recovery builds cannot consume prior image bytes or shared cache artifacts."""
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
SPEC = importlib.util.spec_from_file_location("candidate", ROOT / ".github/scripts/release-candidate.py")
CANDIDATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CANDIDATE)
ACTION = (ROOT / ".github/actions/build-docker-image/action.yml").read_text()


def script_for(name):
    step = ACTION.split(f"    - name: {name}\n", 1)[1].split("    - name:", 1)[0]
    return textwrap.dedent(step.split("      run: |\n", 1)[1])


class CleanReleaseTests(unittest.TestCase):
    def test_recovery_inputs_never_resolve_or_import_a_previous_image(self):
        for version in ("1.4.23", "1.5.0-rc.25"):
            for image in ("platform", "platform-slim", "sandbox-base", "agent-codex"):
                for arch in ("amd64", "arm64"):
                    with self.subTest(version=version, image=image, arch=arch), patch.object(
                        Path, "read_text", return_value=json.dumps({"platform": version})
                    ), patch.object(CANDIDATE, "command") as command:
                        self.assertEqual(CANDIDATE.build_inputs(image, arch), {
                            "version": version, "previous_image": "", "clean_build": True})
                        command.assert_not_called()

    def test_recovery_gate_rejects_evidence_without_the_clean_build_marker(self):
        from test_release_candidate import IDENTITY, record
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inputs = {"version": "1.4.23", "previous_image": "", "clean_build": True}
            records = [record(arch=arch) | inputs for arch in ("amd64", "arm64")]
            def write_records():
                for i, row in enumerate(records):
                    (root / f"{i}.json").write_text(json.dumps(row))
            with patch.object(CANDIDATE, "identity", return_value=IDENTITY), patch.object(
                CANDIDATE, "build_inputs", return_value=inputs
            ):
                write_records()
                CANDIDATE.validate_evidence(root, {"include": [{"image": "platform"}]})
                del records[1]["clean_build"]
                write_records()
                with self.assertRaisesRegex(ValueError, "different release build inputs"):
                    CANDIDATE.validate_evidence(root, {"include": [{"image": "platform"}]})

    def test_clean_build_rejects_a_reused_builder_or_any_previous_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            assets = root / "docker/prev-static-assets"
            assets.mkdir(parents=True)
            (assets / ".gitkeep").write_text("")
            for setup, previous, planted in (("true", "", False), ("false", "", False),
                                               ("true", "old-image", False), ("true", "", True)):
                with self.subTest(setup=setup, previous=previous, planted=planted):
                    if planted:
                        (assets / "old.js").write_text("old payload")
                    result = subprocess.run(["bash", "-c", script_for("Validate clean build isolation")],
                        env=os.environ | {"INPUT_CONTEXT": str(root), "INPUT_SETUP_BUILDER": setup,
                                          "INPUT_PREVIOUS_IMAGE": previous}, capture_output=True, text=True)
                    self.assertEqual(result.returncode == 0,
                                     setup == "true" and not previous and not planted, result.stderr)

    def test_clean_build_discards_cache_flags_and_turbo_secrets(self):
        step = ACTION.split("    - name: Build Docker image\n", 1)[1]
        env_names = re.findall(r"^        ([A-Z_]+):", step, re.M)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            docker = root / "docker"
            docker.write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "$CALLS"\nprintf "%s|%s" "$SECRET_TURBO_TOKEN" "$SECRET_TURBO_TEAM" > "$TOKENS"\n')
            docker.chmod(0o755)
            for clean in ("true", "false"):
                with self.subTest(clean=clean):
                    env = os.environ | dict.fromkeys(env_names, "") | {
                        "PATH": f"{root}:{os.environ['PATH']}", "RUNNER_TEMP": str(root),
                        "GITHUB_OUTPUT": str(root / "output"), "CALLS": str(root / "calls"),
                        "TOKENS": str(root / "tokens"), "INPUT_CONTEXT": "platform",
                        "INPUT_CLEAN_BUILD": clean, "REUSE_BUILDER": "false",
                        "INPUT_CACHE_FROM": "type=registry,ref=old-cache",
                        "INPUT_CACHE_TO": "type=registry,ref=old-cache",
                        "SECRET_TURBO_TOKEN": "test-dummy", "SECRET_TURBO_TEAM": "test-team"}
                    result = subprocess.run(["bash", "-c", script_for("Build Docker image")],
                                            env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    args = (root / "calls").read_text().splitlines()
                    for flag in ("--pull", "--no-cache"):
                        self.assertEqual(flag in args, clean == "true")
                    for flag in ("--cache-from", "--cache-to", "--secret"):
                        self.assertEqual(flag in args, clean != "true")
                    self.assertEqual((root / "tokens").read_text(),
                                     "|" if clean == "true" else "test-dummy|test-team")


if __name__ == "__main__":
    unittest.main()
