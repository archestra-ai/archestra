"""Select each supported line's own release images for the nightly scan."""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("nightly_release_image_scan", SCRIPTS / "nightly-release-image-scan.py")
SCAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCAN)


class ScanTargetsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.origin = self.tmp / "origin"
        self.origin.mkdir()
        git(self.origin, "init", "-q", "-b", "main")
        git(self.origin, "config", "user.email", "ci@example.com")
        git(self.origin, "config", "user.name", "CI")

    def test_each_line_scans_its_own_inventory(self):
        self.commit(agents=["agent-claude-code", "agent-codex", "agent-hermes"], targets=["release/9.9"])
        git(self.origin, "checkout", "-q", "-b", "release/9.9")
        self.commit(agents=["agent-claude-code"], targets=["release/9.9"])
        git(self.origin, "checkout", "-q", "main")
        clone = self.clone()

        rows = SCAN.scan_targets(clone)["include"]

        def images(branch):
            return [row["image"] for row in rows if row["branch"] == branch]

        # The nightly Platform byte scan already covers main's Platform images.
        self.assertEqual(images("main"), ["mcp-server-base", "p4-shim", "sandbox-base",
                                          "agent-claude-code", "agent-codex", "agent-hermes"])
        self.assertEqual(images("release/9.9"), ["platform", "platform-slim", "mcp-server-base", "p4-shim",
                                                 "sandbox-base", "agent-claude-code"])
        for branch in ("main", "release/9.9"):
            head = git(self.origin, "rev-parse", branch)
            self.assertEqual({row["sha"] for row in rows if row["branch"] == branch}, {head})
        agent = next(row for row in rows if row["image"] == "agent-claude-code")
        self.assertEqual((agent["context"], agent["dockerfile"], agent["target"]),
                         ("./platform", "./platform/docker_images/agent/Dockerfile", "agent-claude-code"))

    def test_rejects_a_target_that_is_not_a_release_line(self):
        self.commit(agents=["agent-claude-code"], targets=["feature/x"])

        with self.assertRaisesRegex(ValueError, "Invalid release branch"):
            SCAN.scan_targets(self.clone())

    def test_fails_closed_when_a_line_has_no_remote_branch(self):
        self.commit(agents=["agent-claude-code"], targets=["release/9.9"])

        with self.assertRaises(subprocess.CalledProcessError):
            SCAN.scan_targets(self.clone())

    def commit(self, agents, targets):
        files = {
            ".github/backport-targets.json": json.dumps({"branches": targets}),
            "platform/shared/agent-catalog-images.json": json.dumps({name: name for name in agents}),
            "platform/Dockerfile": "FROM scratch\n",
            "platform/docker_images/mcp_server/Dockerfile": "FROM scratch\n",
            "platform/docker_images/p4_shim/Dockerfile": "FROM scratch\n",
            "platform/docker_images/sandbox_base/Dockerfile": "FROM scratch\n",
            "platform/docker_images/agent/Dockerfile": "FROM scratch AS agent-base\n" + "".join(
                f"FROM agent-base AS {name}\n" for name in agents),
        }
        for path, content in files.items():
            (self.origin / path).parent.mkdir(parents=True, exist_ok=True)
            (self.origin / path).write_text(content)
        policy = self.origin / ".github/scripts/release-image-policy.py"
        policy.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(SCRIPTS / "release-image-policy.py", policy)
        git(self.origin, "add", "-A")
        git(self.origin, "commit", "-q", "-m", "fixture")

    def clone(self):
        clone = self.tmp / "clone"
        if clone.exists():
            shutil.rmtree(clone)
        git(self.tmp, "clone", "-q", str(self.origin), str(clone))
        return clone


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


if __name__ == "__main__":
    unittest.main()
