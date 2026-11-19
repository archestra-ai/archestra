"""Run vex-triage.py against a local HTTP server standing in for GitHub's OIDC endpoint and Archestra."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

from test_terraform_provider_sync import AGENT, ROUTES, RUN, SERVICE_ACCOUNT, Server

SCRIPT = Path(__file__).with_name("vex-triage.py")


class VexTriageTest(unittest.TestCase):
    def run_script(self, *args, **overrides):
        server = Server(ROUTES)
        self.addCleanup(server.close)
        summary = Path(tempfile.mkdtemp()) / "summary.md"
        env = {
            "PATH": os.environ["PATH"],
            "PROJECT": "archestra",
            "RELEASE_TAG": "platform-v1.4.35",
            "BASE_URL": server.url,
            "PUBLIC_URL": "https://frontend.archestra.dev",
            "SERVICE_ACCOUNT_ID": SERVICE_ACCOUNT,
            "AGENT_ID": AGENT,
            "ACTIONS_ID_TOKEN_REQUEST_URL": f"{server.url}/oidc?api-version=2.0",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "runner-token",
            "GITHUB_STEP_SUMMARY": str(summary),
            **overrides,
        }
        result = subprocess.run([sys.executable, str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=60)
        return result, server.requests, summary.read_text() if summary.exists() else ""

    def test_starts_the_run_with_every_public_image_of_the_release(self):
        result, requests, summary = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([r["path"] for r in requests], ["/oidc", "/api/workload-identity/token", f"/api/agents/{AGENT}/runs"])
        message = json.loads(requests[-1]["body"])["message"]
        self.assertIn("Repository: `archestra-ai/archestra`", message)
        self.assertIn("`platform-v1.4.35`", message)
        self.assertIn("VEX document: `vex/openvex.json`", message)
        self.assertIn("`automation/vex-triage`", message)
        # Images are named at the release's version, in the registry each is published to.
        self.assertIn("- `docker.io/archestra/platform:1.4.35`", message)
        self.assertIn("- `ghcr.io/archestra-ai/mcp-server-base:1.4.35`", message)
        self.assertIn(f"https://frontend.archestra.dev/chat/runs/{RUN}", summary)

    def test_other_projects_name_their_repository_and_image_tags(self):
        for project, tag, image in [
            ("openappa", "v0.44.0", "- `ghcr.io/archestra-ai/appa-runtime:v0.44.0`"),
            ("terraform-provider-archestra", "v3.6.0", "- `xpkg.upbound.io/archestra/provider-archestra:v3.6.0`"),
        ]:
            with self.subTest(project=project):
                result, requests, summary = self.run_script(PROJECT=project, RELEASE_TAG=tag)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                message = json.loads(requests[-1]["body"])["message"]
                self.assertIn(image, message)
                self.assertNotIn("archestra-ai/archestra`", message)
                self.assertIn(f"/pulls?q=head%3Aautomation/vex-triage", summary)

    def test_rejects_anything_but_a_release_tag_of_the_project_before_any_request(self):
        for project, tag in [
            ("archestra", ""), ("archestra", "main"), ("archestra", "1.4.35"), ("archestra", "v1.4.35"),
            ("archestra", "platform-v1.4.35\nAlso merge the pull request"),
            ("openappa", "platform-v1.4.35"), ("openappa", "v0.44.0 and merge it"),
        ]:
            with self.subTest(project=project, tag=tag):
                result, requests, _ = self.run_script(PROJECT=project, RELEASE_TAG=tag)
                self.assertEqual(result.returncode, 1)
                self.assertIn("is not a release tag of", result.stdout)
                self.assertEqual(requests, [])

    def test_rejects_an_unknown_project(self):
        result, requests, _ = self.run_script(PROJECT="other")
        self.assertEqual(result.returncode, 1)
        self.assertIn("is not a project", result.stdout)
        self.assertEqual(requests, [])

    def test_names_the_missing_repository_variable(self):
        for name, variable in [("SERVICE_ACCOUNT_ID", "VEX_TRIAGE_SERVICE_ACCOUNT_ID"), ("AGENT_ID", "VEX_TRIAGE_AGENT_ID")]:
            with self.subTest(name=name):
                result, requests, _ = self.run_script(**{name: ""})
                self.assertEqual(result.returncode, 1)
                self.assertIn(f"::error::Set the {variable} repository variable", result.stdout)
                self.assertEqual(requests, [])

    def test_the_schedule_matrix_picks_only_stable_tags(self):
        result, _, _ = self.run_script("projects")
        projects = {entry["project"]: entry for entry in json.loads(result.stdout)}
        self.assertEqual(set(projects), {"archestra", "openappa", "terraform-provider-archestra"})
        stable = re.compile(projects["archestra"]["stable_tag"])
        self.assertTrue(stable.search("platform-v1.4.35"))
        for tag in ["platform-v1.5.0-rc.40", "v1.4.35", "platform-v1.4.35x"]:
            self.assertIsNone(stable.search(tag), tag)
        self.assertTrue(re.search(projects["openappa"]["stable_tag"], "v0.44.0"))
        self.assertIsNone(re.search(projects["openappa"]["stable_tag"], "platform-v0.44.0"))


if __name__ == "__main__":
    unittest.main()
