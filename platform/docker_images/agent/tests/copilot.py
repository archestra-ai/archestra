"""Exercise the pinned, unmodified CLI against synthetic model/MCP endpoints."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

# Reuse the image suite's signed tool-call fixture and streaming wire server.
sys.argv.insert(1, "copilot")
spec = importlib.util.spec_from_file_location("startup", Path(__file__).with_name("mcp-startup.py"))
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)
BIN = Path(os.environ.get("ARCHESTRA_TEST_WRAPPERS", "/usr/local/bin"))


class CopilotTest(unittest.TestCase):
    def run_client(self, failure=None, resume=False, steer=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            server = startup.Gateway(failure)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            # Planted repository MCP configuration must never replace the
            # managed gateway or execute a repository-supplied command.
            marker = root / "planted"
            (root / ".mcp.json").write_text(json.dumps({"mcpServers": {"archestra": {
                "command": "sh", "args": ["-c", f"touch {marker}"]}}}))
            env = {**os.environ, "PATH": str(BIN) + os.pathsep + os.environ["PATH"],
                   "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime),
                   "ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX": str(runtime / "turn"),
                   "ARCHESTRA_AGENT_RUNTIME_MODE": "one_shot",
                   "ARCHESTRA_AGENT_RUNTIME_OPENAPPA": "1",
                   "ARCHESTRA_AGENT_RUNTIME_BINDING": "synthetic-runtime-binding",
                   "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "gpt-4.1",
                   "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "startup-test",
                   "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID": "startup-workspace",
                   "ARCHESTRA_AGENT_RUNTIME_TASK": "Call each recovery tool, then reply STARTUP_OK.",
                   "ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT": "PLATFORM_INSTRUCTION_MARKER",
                   "ARCHESTRA_LLM_PROXY_PROTOCOL": "openai_chat",
                   "ARCHESTRA_VIRTUAL_KEY": "synthetic-virtual-key",
                   "OPENAI_BASE_URL": origin + "/v1",
                   "ARCHESTRA_MCP_GATEWAY_URL": origin + "/mcp",
                   "ARCHESTRA_MCP_GATEWAY_TOKEN": "synthetic-gateway-token"}
            if steer:
                fifo = root / "steer"
                os.mkfifo(fifo)
                env["ARCHESTRA_AGENT_RUNTIME_STEER_FIFO"] = str(fifo)
            try:
                for turn in range(2 if resume else 1):
                    if turn:
                        env["ARCHESTRA_AGENT_RUNTIME_CONTINUE"] = "1"
                        env["ARCHESTRA_AGENT_RUNTIME_BINDING"] = "synthetic-renewed-binding"
                        server.requests.clear()
                        server.calls.clear()
                        server.list_started.clear()
                        server.release.clear()
                        server.catalog_sent = False
                    child = subprocess.Popen([str(BIN / "archestra-copilot")], cwd=root, env=env,
                                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    try:
                        observed = server.discovery_failed if failure in ("initialize", "tools/list") else server.list_started
                        self.assertTrue(observed.wait(15), "CLI never requested its gateway catalog")
                        if failure == "cancel":
                            child.terminate()
                        if not failure or failure == "model":
                            time.sleep(1)
                            self.assertEqual(server.inference(), [], "Inference escaped the catalog barrier")
                            if steer:
                                with open(fifo, "w") as stream:
                                    stream.write("STEER_MARKER reply STARTUP_OK again\n")
                            server.release.set()
                        stdout, stderr = child.communicate(timeout=45)
                    finally:
                        if child.poll() is None:
                            child.kill()
                            child.wait()
                    if failure:
                        self.assertNotEqual(child.returncode, 0, stdout + stderr)
                        self.assertNotIn("synthetic-virtual-key", stdout + stderr)
                        if failure == "model":
                            self.assertTrue(server.inference())
                        else:
                            self.assertEqual(server.inference(), [])
                        envelope = json.loads((runtime / "turn.failure").read_text())
                        expected = "copilot_turn" if failure == "model" else "copilot_interrupted" if failure == "cancel" else "copilot_gateway"
                        self.assertEqual(envelope["code"], expected)
                    else:
                        self.assertEqual(child.returncode, 0, stdout + stderr)
                        self.assertEqual(server.calls, startup.TOOLS)
                        self.assertTrue(all(item["catalog_sent"] for item in server.inference()))
                        self.assertIn("PLATFORM_INSTRUCTION_MARKER", "\n".join(server.prompts))
                        self.assertTrue(server.issued_call_ids)
                        self.assertTrue(set(server.issued_call_ids).issubset(server.returned_call_ids))
                        self.assertEqual((runtime / "final-answer.txt").read_text(), "STARTUP_OK")
                        transcript = json.loads((runtime / "readable-transcript.json").read_text())
                        self.assertEqual(transcript["provider"], "copilot")
                        self.assertEqual(sum(e["type"] == "tool_call" for e in transcript["entries"]), 3 * (turn + 1))
                        self.assertNotIn("synthetic-virtual-key", json.dumps(transcript))
                        binding = env["ARCHESTRA_AGENT_RUNTIME_BINDING"]
                        self.assertTrue(all(value == binding for _, value in server.binding_headers[-8:]))
                        self.assertFalse(marker.exists())
                        self.assertTrue(all("[[gwa1_" in value for key, value in server.descriptions.items() if "archestra__" in key))
                        if steer:
                            self.assertIn("STEER_MARKER", server.prompts[-1])
                        # Native state may retain messages, but never the
                        # managed gateway configuration or provider credential.
                        for path in (runtime / "copilot").rglob("*.json"):
                            self.assertNotIn("synthetic-gateway-token", path.read_text())
                            self.assertNotIn("synthetic-virtual-key", path.read_text())
                # A missing saved native session must never silently start a
                # replacement conversation on a follow-up.
                if resume:
                    env["ARCHESTRA_AGENT_RUNTIME_MODE"] = "interactive"
                    env["ARCHESTRA_AGENT_RUNTIME_TASK"] = ""
                    before = len(server.inference())
                    idle = subprocess.Popen([str(BIN / "archestra-copilot")], env=env, cwd=root,
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    try:
                        time.sleep(1)
                        self.assertEqual(len(server.inference()), before, "Idle resume submitted a prompt")
                        stdout, stderr = idle.communicate("/exit\n", timeout=10)
                        self.assertEqual(idle.returncode, 0, stdout + stderr)
                    finally:
                        if idle.poll() is None:
                            idle.kill()
                            idle.communicate()
                    (runtime / "copilot" / "archestra-session").unlink()
                    refused = subprocess.run([str(BIN / "archestra-copilot")], env=env, capture_output=True)
                    self.assertNotEqual(refused.returncode, 0)
                    self.assertIn(b"no new session was started", refused.stderr)
            finally:
                server.release.set()
                server.shutdown()
                server.server_close()

    def test_discovery_tool_execution_and_resume(self):
        self.run_client(resume=True)

    def test_pipe_steering_runs_after_the_current_prompt(self):
        self.run_client(steer=True)

    def test_provider_rejection_is_a_safe_failed_turn(self):
        self.run_client(failure="model")

    def test_cancellation_stops_the_native_client(self):
        self.run_client(failure="cancel")

    def test_discovery_failure_never_submits_inference(self):
        for method in ("initialize", "tools/list", "empty", "timeout"):
            with self.subTest(method=method):
                self.run_client(failure=method)


if __name__ == "__main__":
    unittest.main()
