"""Gateway failures are classified; replies and credentials never reach the message."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

BIN = Path(os.environ.get("ARCHESTRA_TEST_WRAPPERS", str(Path(__file__).parents[1] / "bin")))
loader = importlib.machinery.SourceFileLoader("diagnostic", str(BIN / "archestra-mcp-startup-diagnostic"))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.headers = self.headers
        if hasattr(self.server, "release"):
            self.server.started.set()
            self.server.release.wait(5)
        self.send_response(self.server.status)
        self.end_headers()
        self.wfile.write(json.dumps({"error": {"message": self.server.message}}).encode())


class Diagnostics(unittest.TestCase):
    def test_known_failure_and_private_reply(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict(os.environ, {"ARCHESTRA_MCP_GATEWAY_URL": f"http://127.0.0.1:{server.server_port}/mcp", "ARCHESTRA_MCP_GATEWAY_TOKEN": "private-token", "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "test-run", "ARCHESTRA_AGENT_RUNTIME_BINDING": "private-binding"}):
                server.status = 400
                server.message = "The runtime gateway request has no bound workspace"
                self.assertEqual(module.diagnose(), "Gateway rejected the runtime workspace binding.")
                self.assertEqual(server.headers["X-Archestra-Run-Id"], "test-run")
                self.assertEqual(server.headers["X-Appa-Session-ID"], "test-run")
                self.assertEqual(server.headers["mcp-method"], "tools/list")
                server.message = "private-token private-binding private data"
                self.assertEqual(module.diagnose(), "Gateway rejected the tool discovery request.")
                server.status = 401
                self.assertEqual(module.diagnose(), "Gateway authentication or access was denied.")
                server.status = 200
                self.assertEqual(module.diagnose(), "")
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_failure_marker_is_published_before_a_stalled_diagnostic(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.status = 400
        server.message = "The runtime gateway request has no bound workspace"
        server.started = threading.Event()
        server.release = threading.Event()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                prefix = str(root / "turn")
                env = dict(os.environ, ARCHESTRA_MCP_GATEWAY_URL=f"http://127.0.0.1:{server.server_port}/mcp", ARCHESTRA_MCP_GATEWAY_TOKEN="private-token", ARCHESTRA_AGENT_RUNTIME_TASK_ID="test-run", ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX=prefix, ARCHESTRA_AGENT_RUNTIME_DIR=directory, ARCHESTRA_AGENT_RUNTIME_MODE="one_shot")
                process = subprocess.Popen([str(BIN / "archestra-mcp-startup-failure")], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    self.assertTrue(server.started.wait(2), "diagnostic did not reach the test gateway")
                    self.assertIsNone(process.poll(), "test gateway should still hold discovery")
                    self.assertTrue(Path(prefix + ".failure").exists())
                    self.assertTrue((root / "turn-complete.failed").exists())
                    self.assertTrue((root / "turn-complete").exists())
                    initial = json.loads(Path(prefix + ".failure").read_text())
                    self.assertEqual(initial["code"], "mcp_startup")
                    self.assertIn("could not load", (root / "final-answer.txt").read_text())
                    server.release.set()
                    process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 0)
                    final = json.loads(Path(prefix + ".failure").read_text())
                    self.assertIn("Gateway rejected the runtime workspace binding.", final["message"])
                    self.assertNotIn("private-token", final["message"])
                    self.assertEqual((root / "final-answer.txt").read_text().strip(), final["message"])
                finally:
                    server.release.set()
                    if process.poll() is None:
                        process.kill()
                        process.communicate()
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
