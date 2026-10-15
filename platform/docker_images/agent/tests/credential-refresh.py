"""The maintained gh wrapper reloads credentials and never falls back after expiry."""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "bin" / "gh"
loader = importlib.machinery.SourceFileLoader("managed_gh", str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class CredentialRefreshTest(unittest.TestCase):
    def test_reload_and_expiry(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "current.json"
            env = {"ARCHESTRA_AGENT_RUNTIME_CREDENTIALS_FILE": str(source), "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "task", "GH_TOKEN": "stale"}
            with patch.dict(os.environ, env, clear=True), patch.object(module.os, "execve") as execute:
                for token in ["first-fixture", "second-fixture"]:
                    source.write_text(json.dumps({"taskId": "task", "credentials": {"GITHUB_TOKEN": {"value": token, "expiresAt": time.time() * 1000 + 60_000}}}))
                    module.main()
                    args = execute.call_args.args
                    self.assertEqual(args[0], "/usr/bin/gh")
                    self.assertEqual(args[2]["GH_TOKEN"], token)
                execute.reset_mock()
                source.write_text(json.dumps({"taskId": "task", "credentials": {"GITHUB_TOKEN": {"value": "expired-fixture", "expiresAt": 1}}}))
                self.assertEqual(module.main(), 75)
                execute.assert_not_called()
                source.write_text(json.dumps({"taskId": "other-task", "credentials": {}}))
                self.assertEqual(module.main(), 75)
                execute.assert_not_called()

    def test_git_helpers_use_the_managed_wrapper_for_every_host(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gh = root / "gh"
            gh.write_text("#!/bin/sh\nfor host in github.com git.example.test; do git config --global credential.https://$host.helper '!/usr/bin/gh auth git-credential'; done\n")
            gh.chmod(0o755)
            env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"], "GIT_CONFIG_GLOBAL": str(root / "gitconfig"), "GH_TOKEN": "fixture", "OPENAI_BASE_URL": ""}
            subprocess.run(["sh", str(SOURCE.parent / "archestra-agent-init")], env=env, check=True)
            for host in ["github.com", "git.example.test"]:
                result = subprocess.check_output(["git", "config", "--global", "--get", f"credential.https://{host}.helper"], env=env, text=True)
                self.assertEqual(result.strip(), "!/usr/local/bin/gh auth git-credential")


if __name__ == "__main__":
    unittest.main()
