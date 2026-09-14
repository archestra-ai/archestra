"""Exercise disposable setup-token parsing without provider credentials."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader("claude_account", str(Path(__file__).resolve().parents[1] / "bin/archestra-claude-account"))
# Container image tests mount only this directory; use the installed helper there.
if not Path(loader.path).exists():
    loader = importlib.machinery.SourceFileLoader("claude_account", "/usr/local/bin/archestra-claude-account")
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)
TOKEN = "sk-ant-oat01-" + "example" * 8


class AccountTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        helper.directory = Path(self.directory.name)
        helper.submitted = helper.directory / "submitted"
        helper.exit_file = helper.directory / "exit-status"
        helper.flow_id = "test-flow"
        self.pane = ""
        self.calls = []
        self.patch = patch.object(subprocess, "run", side_effect=self.process)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def process(self, args, **kwargs):
        self.calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout=self.pane if "capture-pane" in args else "")

    def test_status_never_returns_a_token_or_arbitrary_terminal_output(self):
        self.pane = f"Your token:\n\x1b[32m{TOKEN}\x1b[0m\nPrivate output"
        self.assertEqual(helper.status(), {"state": "connecting", "flowId": "test-flow"})
        self.assertEqual(helper.captured_token(), TOKEN)
        self.pane += "\n" + TOKEN + "other"
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            helper.captured_token()

    def test_only_provider_authorization_urls_are_exposed(self):
        self.pane = "https://example.test/oauth/authorize?secret=private"
        self.assertEqual(helper.status()["state"], "starting")
        self.pane = "https://claude.com/cai/oauth/authorize?state=example&code_challenge=example"
        self.assertEqual(helper.status()["authorizationUrl"], self.pane)
        helper.exit_file.touch()
        helper.submitted.touch()
        self.assertEqual(helper.status(), {"state": "failed"})

    def test_code_is_sent_once_via_stdin_and_bound_to_the_flow(self):
        with patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(helper.directory / "config")}):
            self.invoke({"flowId": "test-flow", "code": "one-time-code"})
            self.invoke({"flowId": "test-flow", "code": "one-time-code"})
            self.invoke({"flowId": "test-flow"})
            loads = [(args, kwargs) for args, kwargs in self.calls if "load-buffer" in args]
            self.assertEqual(len(loads), 1)
            self.assertEqual(loads[0][1]["input"], "one-time-code")
            self.assertNotIn("one-time-code", json.dumps([args for args, _ in self.calls]))
            with self.assertRaisesRegex(ValueError, "expired"):
                self.invoke({"flowId": "other-flow", "code": "ignored"})

    def invoke(self, body):
        with patch("sys.argv", ["helper", "complete"]), patch("sys.stdin", io.StringIO(json.dumps(body))), contextlib.redirect_stdout(io.StringIO()) as output:
            helper.main()
        self.assertEqual(json.loads(output.getvalue()), {"state": "connecting"})


if __name__ == "__main__":
    unittest.main()
