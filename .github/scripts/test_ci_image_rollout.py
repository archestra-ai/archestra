import importlib.util
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).parent


class P4ReuseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.output = self.root / "output"
        self.marker = self.root / "tagged"

        self.git("init", "-q")
        self.git("config", "user.email", "ci@example.test")
        self.git("config", "user.name", "CI")
        context = self.repo / "platform/p4_shim_docker_image"
        context.mkdir(parents=True)
        (context / "Dockerfile").write_text("FROM scratch\n")
        self.git("add", ".")
        self.git("commit", "-qm", "initial image")
        self.previous_sha = self.git("rev-parse", "HEAD").stdout.strip()

        (self.repo / "unrelated.txt").write_text("change elsewhere\n")
        self.git("add", ".")
        self.git("commit", "-qm", "unrelated change")
        self.current_sha = self.git("rev-parse", "HEAD").stdout.strip()

        (self.bin / "docker").write_text(
            "#!/bin/bash\n"
            "if [[ \"$4\" == *\":${PREVIOUS_VERSION}\" && \"${FAKE_SOURCE_MISSING:-}\" == 1 ]]; then exit 1; fi\n"
            "if [[ \"$4\" == *\":${VERSION}\" && \"${FAKE_TARGET_MISMATCH:-}\" == 1 ]]; then\n"
            "  printf '{\"digest\":\"sha256:%064d\"}\\n' 2\n"
            "else\n"
            "  printf '{\"digest\":\"sha256:%064d\"}\\n' 1\n"
            "fi\n"
        )
        (self.bin / "gcloud").write_text(
            "#!/bin/bash\n"
            "touch \"$FAKE_TAG_MARKER\"\n"
            "[[ \"${FAKE_TAG_FAIL:-}\" != 1 ]]\n"
        )
        for command in ("docker", "gcloud"):
            (self.bin / command).chmod(0o755)

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, text=True, capture_output=True, check=True
        )

    def reuse(self, **overrides):
        env = os.environ | {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "IMAGE": "example.invalid/p4-shim",
            "PREVIOUS_VERSION": self.previous_sha,
            "VERSION": self.current_sha,
            "GITHUB_OUTPUT": str(self.output),
            "FAKE_TAG_MARKER": str(self.marker),
        } | overrides
        return subprocess.run(
            ["bash", str(SCRIPTS / "reuse-p4-shim-image.sh")],
            cwd=self.repo,
            env=env,
            text=True,
            capture_output=True,
            check=True,
        )

    def test_unchanged_context_reuses_verified_digest(self):
        self.reuse()
        self.assertTrue(self.marker.exists())
        self.assertEqual(self.output.read_text(), "reused=true\n")

    def test_changed_context_builds_instead(self):
        context_file = self.repo / "platform/p4_shim_docker_image/Dockerfile"
        context_file.write_text("FROM scratch\nCOPY changed /changed\n")
        self.git("add", ".")
        self.git("commit", "-qm", "change image")
        self.reuse()
        self.assertFalse(self.marker.exists())
        self.assertFalse(self.output.exists())

    def test_changed_build_recipe_builds_instead(self):
        recipe = self.repo / ".github/actions/build-docker-image/action.yml"
        recipe.parent.mkdir(parents=True)
        recipe.write_text("name: New build recipe\n")
        self.git("add", ".")
        self.git("commit", "-qm", "change build recipe")
        self.reuse()
        self.assertFalse(self.marker.exists())
        self.assertFalse(self.output.exists())

    def test_missing_source_image_builds_instead(self):
        self.reuse(FAKE_SOURCE_MISSING="1")
        self.assertFalse(self.marker.exists())
        self.assertFalse(self.output.exists())

    def test_failed_tag_or_wrong_digest_builds_instead(self):
        for override in ({"FAKE_TAG_FAIL": "1"}, {"FAKE_TARGET_MISMATCH": "1"}):
            with self.subTest(override=override):
                self.reuse(**override)
                self.assertFalse(self.output.exists())


class RolloutTimelineTests(unittest.TestCase):
    def test_profiler_records_resource_transitions_until_stopped(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            counter = root / "counter"
            kubectl = root / "kubectl"
            kubectl.write_text(
                "#!/bin/bash\n"
                "count=0\n"
                "[[ -f \"$FAKE_COUNTER\" ]] && read -r count < \"$FAKE_COUNTER\"\n"
                "count=$((count + 1))\n"
                "echo \"$count\" > \"$FAKE_COUNTER\"\n"
                "if [[ $count -eq 1 ]]; then state='\"active\":1'; "
                "else state='\"succeeded\":1'; fi\n"
                "printf '{\"items\":[{\"kind\":\"Job\",\"metadata\":"
                "{\"name\":\"test-migrate\",\"uid\":\"123\"},"
                "\"status\":{%s}}]}\\n' \"$state\"\n"
            )
            kubectl.chmod(0o755)
            process = subprocess.Popen(
                [
                    "python3",
                    "-u",
                    str(SCRIPTS / "profile-helm-rollout.py"),
                    "--namespace",
                    "test",
                    "--release",
                    "test",
                    "--interval",
                    "0.01",
                ],
                env=os.environ
                | {"PATH": f"{root}:{os.environ['PATH']}", "FAKE_COUNTER": str(counter)},
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    if counter.exists() and int(counter.read_text()) >= 3:
                        break
                    time.sleep(0.01)
                else:
                    self.fail("profiler did not poll kubectl three times")
            finally:
                process.terminate()
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(stderr, "")
            self.assertIn("active=1 succeeded=0", stdout)
            self.assertIn("active=0 succeeded=1", stdout)
            self.assertIn("Helm command finished", stdout)

    def test_states_distinguish_migration_pull_and_ready_rollout(self):
        spec = importlib.util.spec_from_file_location(
            "profile_helm_rollout", SCRIPTS / "profile-helm-rollout.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.assertEqual(
            module.describe({"kind": "Job", "status": {"active": 1}}),
            "active=1 succeeded=0 failed=0",
        )
        self.assertEqual(
            module.describe(
                {
                    "kind": "Pod",
                    "status": {
                        "phase": "Pending",
                        "containerStatuses": [
                            {
                                "name": "web",
                                "ready": False,
                                "state": {"waiting": {"reason": "ImagePullBackOff"}},
                            }
                        ],
                    },
                }
            ),
            "phase=Pending ready=0/1 waiting=web:ImagePullBackOff",
        )
        self.assertEqual(
            module.describe(
                {
                    "kind": "Deployment",
                    "spec": {"replicas": 4},
                    "status": {"updatedReplicas": 4, "readyReplicas": 3, "availableReplicas": 3},
                }
            ),
            "updated=4 ready=3 available=3/4",
        )


if __name__ == "__main__":
    unittest.main()
