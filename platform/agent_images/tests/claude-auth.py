"""Verify the installed Claude CLI's wire credentials against a local server.

Run inside agent-claude-code with --network=none. The server rejects inference;
no real credentials, model access, or external network are needed.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ClaudeAuthTest(unittest.TestCase):
    def test_native_setup_token_exposes_browser_authorization(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {
                "PATH": os.environ["PATH"], "HOME": directory,
                "CLAUDE_CONFIG_DIR": str(Path(directory) / "config"),
                "ARCHESTRA_AGENT_RUNTIME_CLAUDE_FLOW_ID": "example-flow",
                "DISABLE_AUTOUPDATER": "1",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "TERM": "xterm-256color",
            }
            try:
                subprocess.run(["archestra-claude-account", "start"], env=env, check=True, capture_output=True, timeout=30)
                state = {}
                for _ in range(20):
                    result = subprocess.run(["archestra-claude-account", "status"], env=env, check=True, capture_output=True, timeout=10)
                    state = json.loads(result.stdout)
                    if state["state"] == "awaiting_code":
                        break
                    time.sleep(0.5)
                self.assertEqual(state["state"], "awaiting_code", state)
                self.assertEqual(state["flowId"], "example-flow")
                self.assertTrue(state["authorizationUrl"].startswith(("https://claude.ai/oauth/authorize?", "https://claude.com/cai/oauth/authorize?")))
            finally:
                subprocess.run(["tmux", "kill-session", "-t", "archestra-claude-login"], env=env, capture_output=True)

    def test_subscription_token_transport_and_model_discovery(self):
        token = "sk-ant-oat01-" + "example" * 8
        with tempfile.TemporaryDirectory() as directory:
            env = {
                "PATH": os.environ["PATH"], "HOME": directory,
                "CLAUDE_CONFIG_DIR": str(Path(directory) / "config"),
                "CLAUDE_CODE_OAUTH_TOKEN": token,
                "DISABLE_AUTOUPDATER": "1",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            }
            result = subprocess.run(["archestra-claude-account", "models"], input=json.dumps({"token": token}), text=True, capture_output=True, env=env, timeout=40)
            self.assertEqual(result.returncode, 0, result.stderr)
            metadata = json.loads(result.stdout)
            self.assertTrue(metadata["models"])
            self.assertNotIn(token, result.stdout)
            server = CaptureServer()
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                env["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{server.server_port}"
                # Test the installed CLI's wire format directly. The production
                # subscription wrapper intentionally disallows proxy overrides.
                process = subprocess.Popen(["claude", "--print", "--model", "claude-sonnet-4-6", "--tools", "", "--setting-sources", "", "Reply OK"], env=env, cwd=directory, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    server.received.wait(25)
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                self.assertTrue(server.requests, "No subscription inference reached the local server")
                for request in server.requests:
                    self.assertEqual(request.get("authorization"), f"Bearer {token}")
                    self.assertNotIn("x-api-key", request)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_native_cli_uses_the_selected_credential(self):
        cases = {
            "anthropic": {
                "ANTHROPIC_API_KEY": "arch_test_provider_key",
                "ANTHROPIC_AUTH_TOKEN": "arch_test_provider_key",
            },
            "bedrock": {
                "CLAUDE_CODE_USE_BEDROCK": "1",
                "AWS_BEARER_TOKEN_BEDROCK": "arch_test_provider_key",
                "AWS_REGION": "us-east-1",
            },
        }
        for source, credentials in cases.items():
            with self.subTest(source=source), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                runtime = root / "runtime"
                runtime.mkdir()
                server = CaptureServer()
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                origin = f"http://127.0.0.1:{server.server_port}"
                env = {
                    "PATH": os.environ["PATH"],
                    "HOME": str(root),
                    "TERM": "dumb",
                    "DISABLE_AUTOUPDATER": "1",
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                    "ARCHESTRA_LLM_PROXY_PROTOCOL": "anthropic",
                    "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime),
                    "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": (
                        "us.anthropic.claude-sonnet-4-6"
                        if source == "bedrock"
                        else "claude-sonnet-4-6"
                    ),
                    "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "auth-test",
                    "ARCHESTRA_AGENT_RUNTIME_TASK": "Reply OK. Do not use tools.",
                    "ARCHESTRA_AGENT_RUNTIME_MODE": "one_shot",
                    "ARCHESTRA_AGENT_RUNTIME_PLAIN": "1",
                    "ARCHESTRA_MCP_GATEWAY_URL": f"{origin}/mcp",
                    "ARCHESTRA_MCP_GATEWAY_TOKEN": "test-mcp-token",
                    "ANTHROPIC_BASE_URL": origin,
                    "ANTHROPIC_BEDROCK_BASE_URL": origin,
                    **credentials,
                }
                try:
                    process = subprocess.Popen(
                        ["archestra-claude-code"],
                        cwd=root,
                        env=env,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    try:
                        server.received.wait(25)
                    finally:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                    self.assertTrue(
                        server.requests,
                        f"{source}: no inference request reached the server",
                    )
                    for request in server.requests:
                        self.assertEqual(
                            request.get("authorization"), "Bearer arch_test_provider_key"
                        )
                        self.assertNotIn("x-api-key", request)
                        self.assertNotIn("x-archestra-virtual-key", request)
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join()


class CaptureServer(ThreadingHTTPServer):
    def __init__(self):
        self.requests = []
        self.received = threading.Event()
        super().__init__(("127.0.0.1", 0), CaptureHandler)


class CaptureHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path == "/mcp":
            request = json.loads(body)
            result = (
                {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "auth-test", "version": "1"},
                }
                if request.get("method") == "initialize"
                else {"tools": []}
            )
            self.send_response(200 if "id" in request else 202)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if "id" in request:
                self.wfile.write(
                    json.dumps(
                        {"jsonrpc": "2.0", "id": request["id"], "result": result}
                    ).encode()
                )
            return
        if "/messages" in self.path or "/model/" in self.path:
            self.server.requests.append(
                {key.lower(): value for key, value in self.headers.items()}
            )
            self.server.received.set()
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps(
                {
                    "type": "error",
                    "error": {
                        "type": "authentication_error",
                        "message": "Local credential test complete",
                    },
                }
            ).encode()
        )

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    unittest.main()
