"""Exercise maintained entrypoints with fake native CLIs at the subprocess boundary."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
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


if __name__ == "__main__":
    unittest.main()
