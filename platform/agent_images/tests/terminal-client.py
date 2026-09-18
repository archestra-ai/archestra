"""Harness terminal operations use the facade without selecting a multiplexer."""

import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


BIN = Path(__file__).resolve().parents[1] / "bin"


class TerminalClientTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.runtime = self.root / "runtime"
        self.runtime.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            "root = pathlib.Path(os.environ['ARCHESTRA_AGENT_RUNTIME_DIR'])\n"
            "action = sys.argv[1]\n"
            "if (root / 'fail').exists(): sys.exit(75)\n"
            "if action == 'capture': sys.stdout.buffer.write(b'\\x1b[32mAnswer \\xe2\\x9c\\x93\\x1b[0m\\n')\n"
            "elif action == 'geometry': print('120x40')\n"
            "elif action == 'retained':\n"
            "  assert (root / 'turn.log').read_bytes().endswith((root / 'frame').read_bytes())\n"
            "  (root / 'retained').write_text(sys.argv[2])\n"
            "elif action == 'attention':\n"
            "  state = root / 'attention.json'\n"
            "  if len(sys.argv) > 2: state.write_text(json.dumps(sys.argv[2:]))\n"
            "  else:\n"
            "    current = json.loads(state.read_text()) if state.exists() else ['0', '']\n"
            "    print('\\n'.join(current))\n"
            "else: sys.exit(64)\n"
        )
        self.runtime.chmod(0o755)
        # A driver failure must not quietly reach a different multiplexer.
        tmux = self.root / "tmux"
        tmux.write_text("#!/bin/sh\nprintf invoked > \"$ARCHESTRA_AGENT_RUNTIME_DIR/wrong-driver\"\nexit 0\n")
        tmux.chmod(0o755)
        env = {
            "PATH": f"{BIN}:{self.root}:{os.environ['PATH']}",
            "ARCHESTRA_AGENT_RUNTIME_DIR": str(self.root),
            "ARCHESTRA_AGENT_RUNTIME_ANSWER_FILE": str(self.root / "answer"),
        }
        self.environment = patch.dict(os.environ, env)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.harness = runpy.run_path(str(BIN / "archestra-tui-exec"))

    def test_completion_captures_frame_and_retains_before_publishing_result(self):
        frame = self.root / "frame"
        self.harness["capture_frame"](frame)
        self.assertEqual(
            frame.read_bytes(),
            b"\x1b]777;archestra-terminal-size=120x40\x07\x1b[32mAnswer \xe2\x9c\x93\x1b[0m\n",
        )
        (self.root / "answer").write_text("Answer ✓")
        self.harness["publish_completed_turn"](str(self.root / "turn"), frame)
        self.assertEqual((self.root / "turn.result").read_text(), "0\n")
        self.assertEqual((self.root / "retained").read_text(), "turn")
        self.assertIn(b"Answer \xe2\x9c\x93", (self.root / "turn.log").read_bytes())
        self.assertFalse((self.root / "wrong-driver").exists())

    def test_failed_facade_cannot_publish_success_or_fall_back(self):
        (self.root / "fail").touch()
        with self.assertRaises(subprocess.CalledProcessError):
            self.harness["publish_completed_turn"](str(self.root / "turn"), self.root / "frame")
        self.assertFalse((self.root / "turn.result").exists())
        self.assertFalse((self.root / "wrong-driver").exists())

    def test_redirected_input_still_captures_the_completed_frame(self):
        done = self.root / "done"
        answer = self.root / "answer"
        result = subprocess.run(
            [str(BIN / "archestra-tui-run"), str(done), str(answer), sys.executable, "-c",
             "from pathlib import Path; import sys,time; "
             "Path(sys.argv[2]).write_text('Redirected answer'); "
             "Path(sys.argv[1]).touch(); time.sleep(30)", str(done), str(answer)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"Redirected answer", result.stdout)
        self.assertIn(b"\x1b]777;archestra-terminal-size=120x40\x07", result.stdout)
        self.assertIn(b"\x1b[32mAnswer \xe2\x9c\x93\x1b[0m", result.stdout)
        self.assertFalse((self.root / "wrong-driver").exists())

    def test_attention_reports_changes_and_recovery_without_vendor_commands(self):
        curl = self.root / "curl"
        curl.write_text(
            "#!/usr/bin/env python3\nimport json, os, pathlib, sys\n"
            "args=sys.argv[1:]\n"
            "body=args[args.index('--data-binary')+1]\n"
            "with (pathlib.Path(os.environ['ARCHESTRA_AGENT_RUNTIME_DIR'])/'reports').open('a') as f: f.write(body+'\\n')\n"
        )
        curl.chmod(0o755)
        with patch.dict(os.environ, {
            "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "terminal-client-test",
            "ARCHESTRA_MCP_GATEWAY_TOKEN": "local-test-token",
            "ARCHESTRA_MCP_GATEWAY_URL": "http://127.0.0.1:1",
        }):
            for args in (["set", "Sign in"], ["set", "Sign in"], ["clear"], ["clear"]):
                subprocess.run([str(BIN / "archestra-agent-attention"), *args], check=True)
        reports = [json.loads(line) for line in (self.root / "reports").read_text().splitlines()]
        self.assertEqual([event["attentionState"] for event in reports], ["input_required", None])
        self.assertEqual(json.loads((self.root / "attention.json").read_text()), ["0", ""])
        self.assertFalse((self.root / "wrong-driver").exists())


if __name__ == "__main__":
    unittest.main()
