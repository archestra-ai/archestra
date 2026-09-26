import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).parent


class ImageReuseTests(unittest.TestCase):
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
        agent = self.repo / "platform/agent_images"
        agent.mkdir()
        (agent / "Dockerfile").write_text("FROM scratch AS agent-test\n")
        shared = self.repo / "platform/backend/src/static/workspace-files.py"
        shared.parent.mkdir(parents=True)
        shared.write_text("print('agent helper')\n")
        self.git("add", ".")
        self.git("commit", "-qm", "initial image")
        self.previous_sha = self.git("rev-parse", "HEAD").stdout.strip()

        (self.repo / "unrelated.txt").write_text("change elsewhere\n")
        self.git("add", ".")
        self.git("commit", "-qm", "unrelated change")
        self.current_sha = self.git("rev-parse", "HEAD").stdout.strip()

        (self.bin / "docker").write_text(
            "#!/bin/bash\n"
            "if [[ \"$4\" == *\":${SOURCE_VERSION}\" && \"${FAKE_SOURCE_MISSING:-}\" == 1 ]]; then exit 1; fi\n"
            "if [[ \"$4\" == *\":${VERSION}\" && \"${FAKE_TARGET_MISMATCH:-}\" == 1 ]]; then\n"
            "  printf '{\"digest\":\"sha256:%064d\"}\\n' 2\n"
            "else\n"
            "  printf '{\"digest\":\"sha256:%064d\"}\\n' 1\n"
            "fi\n"
        )
        (self.bin / "gcloud").write_text(
            "#!/bin/bash\n"
            "if [[ \"$3\" == images ]]; then\n"
            "  [[ \"${FAKE_METADATA_MISSING:-}\" != 1 ]] || exit 1\n"
            "  if [[ \"${FAKE_OLD_IMAGE:-}\" == 1 ]]; then\n"
            "    echo 2000-01-01T00:00:00Z\n"
            "  else\n"
            "    python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).isoformat())'\n"
            "  fi\n"
            "  exit 0\n"
            "fi\n"
            "touch \"$FAKE_TAG_MARKER\"\n"
            "[[ \"${FAKE_TAG_FAIL:-}\" != 1 ]]\n"
        )
        for command in ("docker", "gcloud"):
            (self.bin / command).chmod(0o755)

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.repo, text=True, capture_output=True, check=True
        )

    def reuse(self, paths=None, **overrides):
        env = os.environ | {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "IMAGE": "example.invalid/p4-shim",
            "SOURCE_VERSION": self.previous_sha,
            "VERSION": self.current_sha,
            "REUSE_PATHS": json.dumps(
                paths or ["platform/p4_shim_docker_image"]
            ),
            "MAX_AGE_DAYS": "7",
            "GITHUB_OUTPUT": str(self.output),
            "FAKE_TAG_MARKER": str(self.marker),
        } | overrides
        return subprocess.run(
            ["bash", str(SCRIPTS / "reuse-unchanged-gar-image.sh")],
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

    def test_release_tag_reuses_the_same_source_commit(self):
        self.reuse(VERSION="1.4.0-rc.7")
        self.assertEqual(self.output.read_text(), "reused=true\n")

    def test_agent_helper_is_a_build_dependency(self):
        helper = self.repo / "platform/backend/src/static/workspace-files.py"
        helper.write_text("print('changed agent helper')\n")
        self.git("add", ".")
        self.git("commit", "-qm", "change shared agent helper")
        self.reuse(paths=["platform/agent_images", "platform/backend/src/static/workspace-files.py"])
        self.assertFalse(self.marker.exists())
        self.assertFalse(self.output.exists())

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

    def test_missing_metadata_or_stale_image_builds_instead(self):
        for override in ({"FAKE_METADATA_MISSING": "1"}, {"FAKE_OLD_IMAGE": "1"}):
            with self.subTest(override=override):
                self.reuse(**override)
                self.assertFalse(self.marker.exists())
                self.assertFalse(self.output.exists())

    def test_invalid_dependency_paths_build_instead(self):
        self.reuse(REUSE_PATHS='["../outside"]')
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
