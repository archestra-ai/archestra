"""Release images push only with the release publisher token; CI uses GITHUB_TOKEN."""

import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"
ACTION = ROOT / ".github/actions/ghcr-login/action.yml"
SECRET = "GHCR_RELEASE_PUBLISH_TOKEN"


def select_credential(registry, username="", token=""):
    source = ACTION.read_text()
    step = source.split("    - name: Select GHCR credential\n", 1)[1].split("\n    - name:", 1)[0]
    script = textwrap.dedent(step.split("      run: |\n", 1)[1])
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "output"
        output.touch()
        env = {
            "PATH": os.environ["PATH"],
            "GITHUB_OUTPUT": str(output),
            "IMAGE_REGISTRY": registry,
            "HAS_RELEASE_USERNAME": "true" if username else "false",
            "HAS_RELEASE_TOKEN": "true" if token else "false",
        }
        result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True)
        return result.returncode, output.read_text().strip()


class GhcrReleaseCredentialTests(unittest.TestCase):
    def test_release_namespace_requires_the_release_token(self):
        self.assertEqual(select_credential("ghcr.io/archestra-ai", "publisher", "token"), (0, "kind=release"))
        for username, token in (("", ""), ("publisher", ""), ("", "token")):
            with self.subTest(username=username, token=token):
                code, output = select_credential("ghcr.io/archestra-ai", username, token)
                self.assertNotEqual(code, 0)
                self.assertEqual(output, "")

    def test_ci_namespace_uses_the_repository_token(self):
        for registry in ("ghcr.io/archestra-ai/ci", "ghcr.io/archestra-ai/ci/nested"):
            with self.subTest(registry=registry):
                self.assertEqual(select_credential(registry), (0, "kind=ci"))
                self.assertEqual(select_credential(registry, "publisher", "token"), (0, "kind=ci"))

    def test_unknown_namespaces_fail_closed(self):
        for registry in ("ghcr.io/archestra-ai-ci", "ghcr.io/archestra-ai/cix", "ghcr.io/other", "ghcr.io"):
            with self.subTest(registry=registry):
                self.assertEqual(select_credential(registry, "publisher", "token")[0] != 0, True)

    def test_publishers_log_in_to_ghcr_only_through_the_credential_selector(self):
        for name in ("build-native-multi-arch-image.yml", "release-please.yml"):
            with self.subTest(workflow=name):
                source = (WORKFLOWS / name).read_text()
                self.assertIsNone(re.search(r"^\s+registry: ghcr\.io$", source, re.M))
                self.assertIn("./.github/actions/ghcr-login", source)

    def test_release_token_reaches_every_release_image_publisher_and_nothing_else(self):
        release = (WORKFLOWS / "release-please.yml").read_text()
        callers = re.findall(r"^  ([\w-]+):\n(?:(?!^  [\w-]+:\n).*\n)*?    uses: \./\.github/workflows/([\w.-]+)\n"
                             r"((?:(?!^  [\w-]+:\n).*\n)*)", release, re.M)
        wrappers = set()
        for job, workflow, body in callers:
            if workflow == "build-dockerhub-image.yml" or "environment: release-publish" not in body:
                continue
            with self.subTest(job=job):
                self.assertIn(f"{SECRET}: ${{{{ secrets.{SECRET} }}}}", body)
            wrappers.add(workflow)
        self.assertEqual(wrappers, {
            "build-base-mcp-server-docker-image.yml", "build-agent-catalog-images.yml",
            "build-p4-shim-docker-image.yml", "build-sandbox-base-docker-image.yml",
        })
        for wrapper in wrappers:
            with self.subTest(wrapper=wrapper):
                source = (WORKFLOWS / wrapper).read_text()
                self.assertIn(f"{SECRET}: ${{{{ secrets.{SECRET} }}}}", source)
        users = {path.name for path in WORKFLOWS.glob("*.yml") if SECRET in path.read_text()}
        self.assertEqual(users, wrappers | {"release-please.yml", "build-native-multi-arch-image.yml"})


if __name__ == "__main__":
    unittest.main()
