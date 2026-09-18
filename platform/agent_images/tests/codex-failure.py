"""Exercise the pinned Codex TUI against a local provider rejecting credentials."""

import fcntl
import http.server
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
import unittest
from unittest.mock import patch


BIN = Path(os.environ.get("ARCHESTRA_TEST_WRAPPERS", "/usr/local/bin"))
loader = importlib.machinery.SourceFileLoader("codex_failure_watch", str(BIN / "archestra-codex-failure-watch"))
spec = importlib.util.spec_from_loader(loader.name, loader)
watcher = importlib.util.module_from_spec(spec)
loader.exec_module(watcher)


class FailureWatchTest(unittest.TestCase):
    def test_redacts_encoded_and_projected_credentials_and_bounds_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            credentials = runtime / "credentials.json"
            credentials.write_text(json.dumps({"credentials": {"CUSTOM_KEY": {"value": "projected/value"}}}))
            with patch.dict(os.environ, {"OPENAI_API_KEY": 'secret/with"quote', "ARCHESTRA_AGENT_RUNTIME_CREDENTIALS_FILE": str(credentials), "ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX": str(runtime / "turn")}, clear=True):
                message = watcher.public_message('Authentication failed: secret/with"quote secret%2Fwith%22quote secret/with\\"quote projected%2Fvalue Bearer unknown-token https://user:password@example.test/secret?token=value')
                self.assertNotIn("secret", message)
                self.assertNotIn("projected", message)
                self.assertNotIn("unknown-token", message)
                self.assertIn("Authentication failed", message)
                watcher.publish_failure(runtime, "Authentication failed. " + "\U0001f99e" * 3000)
                encoded = (runtime / "turn.failure").read_bytes()
                self.assertLessEqual(len(encoded), 4096)
                self.assertLessEqual(len(json.loads(encoded)["message"].encode("utf-16-le")) // 2, 2000)
                self.assertTrue((runtime / "turn-complete.failed").exists())

    def test_extracts_message_without_private_response_fields(self):
        self.assertEqual(
            watcher.public_message('unexpected status 401: {"error":{"message":"Reconnect your account.","internal":"private response"}}, url: https://example.test'),
            "unexpected status 401: Reconnect your account.",
        )

    def test_redacts_generic_credentials_and_normalizes_controls(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                watcher.public_message('Authentication failed. password="several secret words" api key: unknown-key Bearer unknown-bearer eyJhbGciOiJIUzI1NiJ9.payload.signature\r\nRetry.\rPlease.\x01'),
                'Authentication failed. password="[REDACTED]" api key: [REDACTED] Bearer [REDACTED] [REDACTED]\nRetry.\nPlease.',
            )
            self.assertIn("Check the configured provider credential", watcher.public_message("\r\x01"))

    def test_successful_retained_turn_ignores_later_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            transcript = runtime / "main.jsonl"
            transcript.write_text("")
            with patch.dict(os.environ, {"CODEX_HOME": str(runtime), "ARCHESTRA_AGENT_RUNTIME_MODE": "one_shot"}, clear=True):
                watch = watcher.FailureWatch(runtime)
                (runtime / "codex-main-transcript").write_text(str(transcript))
                transcript.write_text(json.dumps({"type": "event_msg", "payload": {"type": "task_complete"}}) + "\n")
                watch.poll()
                with transcript.open("a") as output:
                    output.write(json.dumps({"type": "event_msg", "payload": {"type": "task_complete", "error": {"message": "later failure"}}}) + "\n")
                watch.poll()
                self.assertFalse((runtime / "turn-complete.failed").exists())

    def test_real_codex_authentication_errors_settle_delegated_tui(self):
        for upstream_message in (
            "Authentication failed. Reconnect your account.",
            "Provider API key is not registered. Select a valid provider key.",
        ):
            with self.subTest(message=upstream_message):
                self.run_native_failure(upstream_message)

    def run_native_failure(self, upstream_message):
        class Provider(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                if self.path == "/mcp":
                    if request.get("method") == "initialize":
                        result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "test", "version": "1"}}
                    else:
                        result = {"tools": []}
                    status = 200
                    response = {"jsonrpc": "2.0", "id": request.get("id"), "result": result}
                else:
                    status = 401
                    response = {"error": {"message": upstream_message, "type": "authentication_error"}}
                data = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *_args):
                pass

        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory)
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            endpoint = f"http://127.0.0.1:{server.server_port}"
            env = {**os.environ, "TERM": "xterm-256color", "PATH": str(BIN) + os.pathsep + os.environ["PATH"],
                   "ARCHESTRA_LLM_PROXY_PROTOCOL": "openai_responses", "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime),
                   "ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX": str(runtime / "turn"), "ARCHESTRA_AGENT_RUNTIME_MODE": "one_shot",
                   "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "gpt-5.6-terra", "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "test-task",
                   "ARCHESTRA_AGENT_RUNTIME_TASK": "Say hello.", "ARCHESTRA_MCP_GATEWAY_URL": endpoint + "/mcp",
                   "ARCHESTRA_MCP_GATEWAY_TOKEN": "synthetic-token", "OPENAI_API_KEY": "synthetic-invalid-key", "OPENAI_BASE_URL": endpoint + "/v1"}
            pid, fd = pty.fork()
            if pid == 0:
                os.chdir(runtime)
                os.execve("/bin/bash", ["bash", str(BIN / "archestra-codex")], env)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
            status = None
            deadline = time.monotonic() + 40
            try:
                while time.monotonic() < deadline:
                    if select.select([fd], [], [], 0.1)[0]:
                        try:
                            chunk = os.read(fd, 65536)
                        except OSError:
                            chunk = b""
                        if b"\x1b[6n" in chunk:
                            os.write(fd, b"\x1b[1;1R")
                        if b"\x1b[c" in chunk:
                            os.write(fd, b"\x1b[?1;2c")
                    exited, child_status = os.waitpid(pid, os.WNOHANG)
                    if exited:
                        status = os.waitstatus_to_exitcode(child_status)
                        break
                self.assertEqual(status, 1, "delegated TUI must exit after the provider rejects the turn")
                envelope = json.loads((runtime / "turn.failure").read_text())
                self.assertEqual(envelope, {"version": 1, "code": "codex_turn_failed", "message": "unexpected status 401 Unauthorized: " + upstream_message})
                self.assertEqual((runtime / "final-answer.txt").read_text(), envelope["message"] + "\n")
                self.assertTrue((runtime / "turn-complete.failed").exists())
            finally:
                if status is None:
                    os.kill(pid, signal.SIGTERM)
                os.close(fd)
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
