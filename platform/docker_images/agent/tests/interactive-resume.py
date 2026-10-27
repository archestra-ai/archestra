"""Exercise maintained entrypoints with fake native CLIs at the subprocess boundary."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

BIN = Path(__file__).resolve().parents[1] / "bin"
if not BIN.is_dir():
    BIN = Path("/usr/local/bin")
CLIENTS = {
    "claude-code": ("claude", "anthropic", "claude-session-id"),
    "codex": ("codex", "openai_responses", "codex-main-session"),
    "hermes": ("hermes", "openai_chat", "hermes-main-session"),
    "opencode": ("opencode", "openai_responses", "opencode-main-session"),
    "openclaw": ("openclaw", "openai_chat", None),
}


class InteractiveResumeTest(unittest.TestCase):
    def launch(self, client, prompt):
        executable, protocol, session_file = CLIENTS[client]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            if session_file:
                (runtime / session_file).write_text("saved-session")
            fake = root / executable
            fake.write_text("#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n")
            fake.chmod(0o755)
            env = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "HOME": str(root),
                "CLAUDE_CONFIG_DIR": str(root),
                "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime),
                "ARCHESTRA_AGENT_RUNTIME_NATIVE_STATE_DIR": str(runtime),
                "ARCHESTRA_AGENT_RUNTIME_MODE": "interactive",
                "ARCHESTRA_AGENT_RUNTIME_CONTINUE": "1",
                "ARCHESTRA_AGENT_RUNTIME_TASK": prompt,
                "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "test-turn",
                "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID": "saved-session",
                "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "test-model",
                "ARCHESTRA_LLM_PROXY_PROTOCOL": protocol,
                "ARCHESTRA_MCP_GATEWAY_URL": "http://localhost:1/mcp",
                "ARCHESTRA_MCP_GATEWAY_TOKEN": "fixture",
                "OPENAI_BASE_URL": "http://localhost:1/v1",
                "OPENAI_API_KEY": "fixture",
            }
            entrypoint = BIN / f"archestra-{client}"
            if client == "claude-code":
                # This suite stubs native CLIs. The real terminal discovery gate
                # is exercised by mcp-startup.py, not this argument-capture stub.
                image_bin = root / "image-bin"
                image_bin.mkdir()
                entrypoint = image_bin / "archestra-claude-code"
                entrypoint.write_text((BIN / "archestra-claude-code").read_text())
                (image_bin / "archestra-agent-instructions").symlink_to(
                    BIN / "archestra-agent-instructions"
                )
                (image_bin / "archestra-claude-tui-start").write_text(
                    'import os, sys\ntask = os.environ.get("ARCHESTRA_AGENT_RUNTIME_TASK", "")\n'
                    'os.execvp(sys.argv[1], sys.argv[1:] + ([task] if task else []))\n'
                )
            result = subprocess.run(["bash", str(entrypoint)], env=env, cwd=root, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout.strip().splitlines()[-1])

    def test_resume_opens_saved_session_without_submitting_a_prompt(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                args = self.launch(client, "")
                self.assertTrue(any("saved-session" in arg for arg in args))
                for flag in ("--prompt", "--query", "--message"):
                    self.assertNotIn(flag, args)
                self.assertNotIn("", args)

    def test_follow_up_instructions_still_reach_native_client(self):
        for client in CLIENTS:
            with self.subTest(client=client):
                args = self.launch(client, "Review the saved change")
                self.assertIn("Review the saved change", args)


FAKE_GROK = """#!/usr/bin/env python3
import datetime, json, os, select, sys
from pathlib import Path
runtime = Path(os.environ["ARCHESTRA_AGENT_RUNTIME_DIR"])
(runtime / "fake-args.json").write_text(json.dumps(sys.argv[1:]))
# The session's own MCP record, as Grok writes it once tools/list returned.
session = Path(os.environ["GROK_HOME"]) / "sessions" / "%2Fwork" / "saved-session"
session.mkdir(parents=True, exist_ok=True)
now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
(session / "events.jsonl").write_text(json.dumps({"ts": now, "type": "mcp_server_connected", "server_name": "archestra", "tool_count": 3}) + "\\n")
print("\\u256d\\u2500\\n\\u2502 \\u276f", flush=True)
if select.select([sys.stdin], [], [], 15)[0]:
    (runtime / "fake-input.txt").write_text(sys.stdin.readline().strip())
"""


class GrokInteractiveResumeTest(unittest.TestCase):
    """Grok receives follow-ups as terminal input once its MCP gate passes."""

    def launch(self, prompt):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / "grok-main-session").write_text("saved-session")
            fake = root / "grok"
            fake.write_text(FAKE_GROK)
            fake.chmod(0o755)
            env = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "HOME": str(root),
                "TERM": "xterm-256color",
                "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime),
                "ARCHESTRA_AGENT_RUNTIME_NATIVE_STATE_DIR": str(runtime),
                "ARCHESTRA_AGENT_RUNTIME_MODE": "interactive",
                "ARCHESTRA_AGENT_RUNTIME_CONTINUE": "1",
                "ARCHESTRA_AGENT_RUNTIME_OPENAPPA": "0",
                "ARCHESTRA_AGENT_RUNTIME_TASK": prompt,
                "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "test-turn",
                "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID": "saved-session",
                "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "test-model",
                "ARCHESTRA_LLM_PROXY_PROTOCOL": "openai_chat",
                "ARCHESTRA_MCP_GATEWAY_URL": "http://localhost:1/mcp",
                "ARCHESTRA_MCP_GATEWAY_TOKEN": "fixture",
                "OPENAI_BASE_URL": "http://localhost:1/v1",
                "OPENAI_API_KEY": "fixture",
            }
            env.pop("TMUX", None)
            socket = f"grok-resume-{root.name}"
            tmux = ["tmux", "-L", socket]
            subprocess.run(tmux + ["new-session", "-d", "-s", "agent", "-x", "120", "-y", "30", "-c", str(root), "bash", str(BIN / "archestra-grok")], env=env, check=True)
            try:
                deadline = time.monotonic() + 30
                done = runtime / ("fake-input.txt" if prompt else "fake-args.json")
                while time.monotonic() < deadline and not done.exists():
                    time.sleep(0.2)
                if not prompt:
                    # Give the gate time to (wrongly) submit something.
                    time.sleep(2)
                args = json.loads((runtime / "fake-args.json").read_text())
                pasted = (runtime / "fake-input.txt").read_text() if (runtime / "fake-input.txt").exists() else None
                return args, pasted
            finally:
                subprocess.run(tmux + ["kill-session", "-t", "agent"], stderr=subprocess.DEVNULL, check=False)

    def test_resume_opens_saved_session_without_submitting_a_prompt(self):
        args, pasted = self.launch("")
        self.assertEqual(args, ["--trust", "--always-approve", "--resume", "saved-session"])
        self.assertIsNone(pasted)

    def test_follow_up_instructions_reach_the_resumed_session(self):
        args, pasted = self.launch("Review the saved change")
        self.assertIn("saved-session", args)
        self.assertEqual(pasted, "Review the saved change")


FAKE_KIMI = """#!/usr/bin/env python3
import json, os, select, sys
from pathlib import Path
runtime = Path(os.environ["ARCHESTRA_AGENT_RUNTIME_DIR"])
(runtime / "fake-args.json").write_text(json.dumps(sys.argv[1:]))
# The outcome the gateway bridge records once Kimi's tools/list returned.
Path(os.environ["ARCHESTRA_KIMI_GATEWAY_STATE"]).write_text(json.dumps({"state": "ready", "tools": 3}))
print("\\u256d\\u2500\\n\\u2502 >", flush=True)
if select.select([sys.stdin], [], [], 15)[0]:
    (runtime / "fake-input.txt").write_text(sys.stdin.readline().strip())
"""


class KimiInteractiveResumeTest(unittest.TestCase):
    """Kimi receives follow-ups as terminal input once its MCP gate passes."""

    def launch(self, prompt):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / "kimi-main-session").write_text("saved-session")
            fake = root / "kimi"
            fake.write_text(FAKE_KIMI)
            fake.chmod(0o755)
            env = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "HOME": str(root),
                "TERM": "xterm-256color",
                "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime),
                "ARCHESTRA_AGENT_RUNTIME_NATIVE_STATE_DIR": str(runtime),
                "ARCHESTRA_AGENT_RUNTIME_MODE": "interactive",
                "ARCHESTRA_AGENT_RUNTIME_CONTINUE": "1",
                "ARCHESTRA_AGENT_RUNTIME_OPENAPPA": "0",
                "ARCHESTRA_AGENT_RUNTIME_TASK": prompt,
                "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "test-turn",
                "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID": "saved-session",
                "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "test-model",
                "ARCHESTRA_LLM_PROXY_PROTOCOL": "openai_chat",
                "ARCHESTRA_MCP_GATEWAY_URL": "http://localhost:1/mcp",
                "ARCHESTRA_MCP_GATEWAY_TOKEN": "fixture",
                "OPENAI_BASE_URL": "http://localhost:1/v1",
                "OPENAI_API_KEY": "fixture",
            }
            env.pop("TMUX", None)
            socket = f"kimi-resume-{root.name}"
            tmux = ["tmux", "-L", socket]
            subprocess.run(tmux + ["new-session", "-d", "-s", "agent", "-x", "120", "-y", "30", "-c", str(root), "bash", str(BIN / "archestra-kimi")], env=env, check=True)
            try:
                deadline = time.monotonic() + 30
                done = runtime / ("fake-input.txt" if prompt else "fake-args.json")
                while time.monotonic() < deadline and not done.exists():
                    time.sleep(0.2)
                if not prompt:
                    # Give the gate time to (wrongly) submit something.
                    time.sleep(2)
                args = json.loads((runtime / "fake-args.json").read_text())
                pasted = (runtime / "fake-input.txt").read_text() if (runtime / "fake-input.txt").exists() else None
                return args, pasted
            finally:
                subprocess.run(tmux + ["kill-session", "-t", "agent"], stderr=subprocess.DEVNULL, check=False)

    def test_resume_opens_saved_session_without_submitting_a_prompt(self):
        args, pasted = self.launch("")
        self.assertEqual(args, ["--yolo", "--session", "saved-session"])
        self.assertIsNone(pasted)

    def test_follow_up_instructions_reach_the_resumed_session(self):
        args, pasted = self.launch("Review the saved change")
        self.assertIn("saved-session", args)
        self.assertEqual(pasted, "Review the saved change")


if __name__ == "__main__":
    unittest.main()
