"""Run the workflows' real required-gate shell programs over failure results."""

import os
from pathlib import Path
import re
import subprocess
import unittest


WORKFLOWS = Path(__file__).parent.parent / "workflows"


def gate_script(workflow, job):
    source = (WORKFLOWS / workflow).read_text()
    section = re.search(
        rf"^  {re.escape(job)}:\n(.*?)(?=^  [\w-]+:|\Z)", source, re.M | re.S
    ).group(1)
    lines = section.split("        run: |\n", 1)[1].splitlines()
    script = []
    for line in lines:
        if line and not line.startswith("          "):
            break
        script.append(line[10:])
    return "\n".join(script)


class RequiredResultTests(unittest.TestCase):
    def backend(self, **overrides):
        return subprocess.run(
            ["bash", "-e", "-c", gate_script("on-pull-requests.yml", "backend-unit-tests-gate")],
            env=os.environ | {
                "INPUTS_RESULT": "success", "RUN_SHARDS": "true",
                "DEPENDENCIES_RESULT": "success", "SHARDS_RESULT": "success",
            } | overrides,
            capture_output=True, text=True,
        )

    def test_backend_requires_successful_preparation_and_every_shard(self):
        self.assertEqual(self.backend().returncode, 0)
        for variable in ("INPUTS_RESULT", "DEPENDENCIES_RESULT", "SHARDS_RESULT"):
            for result in ("failure", "cancelled", "skipped", ""):
                with self.subTest(variable=variable, result=result):
                    self.assertNotEqual(self.backend(**{variable: result}).returncode, 0)

    def test_backend_skip_requires_explicit_input_decision(self):
        self.assertEqual(self.backend(
            RUN_SHARDS="false", DEPENDENCIES_RESULT="skipped", SHARDS_RESULT="skipped",
        ).returncode, 0)
        for result in ("failure", "cancelled", ""):
            with self.subTest(result=result):
                self.assertNotEqual(self.backend(
                    INPUTS_RESULT=result, RUN_SHARDS="false",
                    DEPENDENCIES_RESULT="skipped", SHARDS_RESULT="skipped",
                ).returncode, 0)
        self.assertNotEqual(self.backend(RUN_SHARDS="").returncode, 0)

    def e2e(self, **overrides):
        return subprocess.run(
            ["bash", "-e", "-c", gate_script("platform-e2e-tests.yml", "platform-e2e-merge-reports")],
            env=os.environ | {
                "K8S_RESULT": "success", "LITE_RESULT": "success",
                "QUICKSTART_RESULT": "success", "HIBERNATION_RESULT": "skipped",
                "RUN_HIBERNATION": "false",
            } | overrides,
            capture_output=True, text=True,
        )

    def test_failed_build_cannot_pass_via_skipped_e2e_consumers(self):
        self.assertEqual(self.e2e().returncode, 0)
        self.assertNotEqual(self.e2e(
            K8S_RESULT="skipped", LITE_RESULT="skipped", QUICKSTART_RESULT="skipped",
        ).returncode, 0)
        for variable in ("K8S_RESULT", "LITE_RESULT", "QUICKSTART_RESULT"):
            for result in ("failure", "cancelled", "skipped", ""):
                with self.subTest(variable=variable, result=result):
                    self.assertNotEqual(self.e2e(**{variable: result}).returncode, 0)

    def test_full_e2e_lane_still_requires_hibernation(self):
        self.assertEqual(self.e2e(
            RUN_HIBERNATION="true", HIBERNATION_RESULT="success",
        ).returncode, 0)
        for result in ("failure", "cancelled", "skipped", ""):
            with self.subTest(result=result):
                self.assertNotEqual(self.e2e(
                    RUN_HIBERNATION="true", HIBERNATION_RESULT=result,
                ).returncode, 0)


if __name__ == "__main__":
    unittest.main()
