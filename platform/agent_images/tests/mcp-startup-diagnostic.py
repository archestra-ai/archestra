"""Gateway failures are classified; replies and credentials never reach the message."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader("diagnostic", str(Path(__file__).parents[1] / "bin/archestra-mcp-startup-diagnostic"))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.headers = self.headers
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


if __name__ == "__main__":
    unittest.main()
