import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "release_artifacts", Path(__file__).with_name("release-artifacts.py")
)
artifacts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifacts)


class ReleaseArtifactTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.previous_cwd = Path.cwd()
        os.chdir(directory.name)
        self.addCleanup(os.chdir, self.previous_cwd)
        self.registry = "registry.example.com/project/images"
        self.digest = "sha256:" + "a" * 64
        self.chart = Path("archestra-platform-1.4.0.tgz")
        self.chart.write_bytes(b"qualified chart archive")
        self.manifest = {
            "version": "1.4.0",
            "commit": "b" * 40,
            "build_run_id": "123",
            "chart_sha256": hashlib.sha256(self.chart.read_bytes()).hexdigest(),
            "images": {
                name: self.digest for name in artifacts.image_names(self.registry)
            },
        }
        self.path = Path("release-artifacts.json")
        self.path.write_text(json.dumps(self.manifest))

    def run_cli(self, command, digest=None, version="1.4.0"):
        with (
            patch.dict(os.environ, AUX_IMAGE_REGISTRY=self.registry),
            patch(
                "sys.argv",
                [
                    "release-artifacts.py",
                    command,
                    "--version",
                    version,
                    "--commit",
                    "b" * 40,
                    "--run-id",
                    "123",
                    "--manifest-sha256",
                    digest or artifacts.sha256(self.path),
                ],
            ),
        ):
            artifacts.main()

    def test_record_then_publish_uses_qualified_digests_without_building(self):
        with (
            patch.object(
                artifacts.subprocess,
                "check_output",
                return_value=json.dumps({"digest": self.digest}),
            ),
            patch.object(artifacts.subprocess, "run") as run,
        ):
            self.run_cli("record")
            self.run_cli("check")
            run.assert_not_called()
            self.run_cli("publish")
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(
                commands[0],
                ["helm", "push", str(self.chart), f"oci://{self.registry}/helm-charts"],
            )
            self.assertEqual(len(commands), len(self.manifest["images"]) + 1)
            for command in commands[1:]:
                self.assertEqual(
                    command[:5], ["docker", "buildx", "imagetools", "create", "--tag"]
                )
                self.assertTrue(command[5].endswith(":latest"))
                self.assertTrue(command[6].endswith("@" + self.digest))
            self.assertIn("docker.io/archestra/platform:latest", commands[-1])

    def test_changed_manifest_is_rejected_before_network_or_writes(self):
        with (
            patch.object(artifacts.subprocess, "check_output") as inspect,
            patch.object(artifacts.subprocess, "run") as run,
        ):
            with self.assertRaises(ValueError):
                self.run_cli("publish", "0" * 64)
            inspect.assert_not_called()
            run.assert_not_called()

    def test_changed_chart_or_missing_image_cannot_publish(self):
        for change in ("chart", "image", "commit", "run"):
            with (
                self.subTest(change=change),
                patch.object(artifacts.subprocess, "run") as run,
            ):
                modified = json.loads(json.dumps(self.manifest))
                if change == "chart":
                    modified["chart_sha256"] = "0" * 64
                elif change == "image":
                    modified["images"].pop("docker.io/archestra/platform")
                elif change == "commit":
                    modified["commit"] = "c" * 40
                else:
                    modified["build_run_id"] = "456"
                self.path.write_text(json.dumps(modified))
                with self.assertRaises(ValueError):
                    self.run_cli("publish")
                run.assert_not_called()

    def test_changed_last_image_does_not_partially_publish(self):
        results = [json.dumps({"digest": self.digest})] * (
            len(self.manifest["images"]) - 1
        )
        results.append(json.dumps({"digest": "sha256:" + "c" * 64}))
        with (
            patch.object(artifacts.subprocess, "check_output", side_effect=results),
            patch.object(artifacts.subprocess, "run") as run,
        ):
            with self.assertRaises(ValueError):
                self.run_cli("publish")
            run.assert_not_called()

    def test_beta_records_artifacts_but_never_moves_stable_aliases(self):
        candidate = "1.4.0-beta.1"
        self.chart.rename(f"archestra-platform-{candidate}.tgz")
        self.manifest["version"] = candidate
        self.path.write_text(json.dumps(self.manifest))
        with (
            patch.object(
                artifacts.subprocess,
                "check_output",
                return_value=json.dumps({"digest": self.digest}),
            ),
            patch.object(artifacts.subprocess, "run") as run,
        ):
            self.run_cli("record", version=candidate)
            self.run_cli("check", version=candidate)
            with self.assertRaisesRegex(ValueError, "Only stable versions"):
                self.run_cli("publish", version=candidate)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
