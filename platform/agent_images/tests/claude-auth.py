"""Verify the installed Claude CLI's wire credentials against a local server.

Run inside agent-claude-code with --network=none. The server rejects inference;
no real credentials, model access, or external network are needed.
"""

import json
import importlib.machinery
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ACCOUNT_COMMAND = str(Path(__file__).resolve().parents[1] / "bin/archestra-claude-account")
if not Path(ACCOUNT_COMMAND).exists():
    ACCOUNT_COMMAND = "/usr/local/bin/archestra-claude-account"
CODE_COMMAND = str(Path(__file__).resolve().parents[1] / "bin/archestra-claude-code")
if not Path(CODE_COMMAND).exists():
    CODE_COMMAND = "archestra-claude-code"


def load_account_helper():
    loader = importlib.machinery.SourceFileLoader(
        "claude_account_auth_test", ACCOUNT_COMMAND
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    helper = importlib.util.module_from_spec(spec)
    loader.exec_module(helper)
    return helper


class ClaudeAuthTest(unittest.TestCase):
    def test_native_setup_token_exposes_browser_authorization_through_herdr(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            write_fake_herdr(fake_bin / "herdr")
            env = {
                "PATH": f"{fake_bin}:{os.environ['PATH']}",
                "HOME": directory,
                "CLAUDE_CONFIG_DIR": str(root / "config"),
                "ARCHESTRA_AGENT_RUNTIME_CLAUDE_FLOW_ID": "example-flow",
                "DISABLE_AUTOUPDATER": "1",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "TERM": "xterm-256color",
                "ARCHESTRA_TEST_SEND_COUNT": str(root / "send-count"),
            }
            cleanup = subprocess.run(
                [ACCOUNT_COMMAND, "cleanup"],
                env=env,
                capture_output=True,
                timeout=30,
            )
            self.assertIn(cleanup.returncode, (0, 1))
            try:
                result = subprocess.run(
                    [ACCOUNT_COMMAND, "start"],
                    env=env,
                    check=True,
                    capture_output=True,
                    timeout=30,
                )
                state = json.loads(result.stdout)
                self.assertEqual(state["state"], "awaiting_code", state)
                self.assertEqual(state["flowId"], "example-flow")
                self.assertGreater(len(state["authorizationUrl"]), 1000)
                self.assertTrue(
                    state["authorizationUrl"].startswith(
                        (
                            "https://claude.ai/oauth/authorize?",
                            "https://claude.com/cai/oauth/authorize?",
                        )
                    )
                )

                code = "one-time-code"
                for _ in range(2):
                    completed = subprocess.run(
                        [ACCOUNT_COMMAND, "complete"],
                        env=env,
                        input=json.dumps({"flowId": "example-flow", "code": code}),
                        text=True,
                        capture_output=True,
                        check=True,
                        timeout=30,
                    )
                    self.assertEqual(json.loads(completed.stdout), {"state": "connecting"})
                    self.assertNotIn(code, completed.stdout)
                    self.assertNotIn(code, completed.stderr)
                self.assertEqual(
                    (root / "send-count").read_text(encoding="utf-8"), "1"
                )
                config = Path("/tmp/archestra-claude-account/herdr-config.toml")
                self.assertIn("headless_cols = 500", config.read_text())
                self.assertIn("headless_rows = 40", config.read_text())
                self.assertIn("version_check = false", config.read_text())
                self.assertIn("manifest_check = false", config.read_text())
            finally:
                subprocess.run(
                    [ACCOUNT_COMMAND, "cleanup"],
                    env=env,
                    capture_output=True,
                    timeout=30,
                )
                (root / "send-count").unlink(missing_ok=True)

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
            helper = load_account_helper()
            helper.directory = Path(directory)
            with patch.object(helper, "validate_subscription_token"), patch(
                "sys.stdin", io.StringIO(json.dumps({"token": token}))
            ):
                metadata = helper.models()
            self.assertTrue(metadata["models"])
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
                        [CODE_COMMAND],
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


def write_fake_herdr(path):
    path.write_text(
        r'''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import socket

socket_path = Path(os.environ["HERDR_SOCKET_PATH"])
socket_path.parent.mkdir(parents=True, exist_ok=True)
socket_path.unlink(missing_ok=True)
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(str(socket_path))
server.listen(8)
send_count = Path(os.environ.get("ARCHESTRA_TEST_SEND_COUNT", "/tmp/archestra-claude-account/send-count"))
long_url = "https://claude.com/cai/oauth/authorize?state=" + "a" * 520 + "&code_challenge=" + "b" * 520
running = True
while running:
    connection, _ = server.accept()
    with connection:
        request = json.loads(connection.makefile("rb").readline())
        method = request["method"]
        params = request.get("params", {})
        if method == "layout.apply":
            raw = Path("/tmp/archestra-claude-account/terminal.raw")
            wrapped = "\n".join(long_url[index:index + 500] for index in range(0, len(long_url), 500))
            raw.write_text("setup-token\n" + wrapped + "\n", encoding="utf-8")
            result = {"type": "layout_apply", "layout": {"root": {"type": "pane", "pane_id": "pane-1"}}}
        elif method == "pane.send_text":
            send_count.write_text(str(int(send_count.read_text()) + 1) if send_count.exists() else "1")
            result = {"type": "pane_info"}
        elif method == "ping":
            result = {"type": "pong"}
        elif method == "server.stop":
            result = {"type": "server_stopped"}
            running = False
        elif method == "workspace.create":
            result = {"type": "workspace_created", "workspace": {"workspace_id": "workspace-1"}, "tab": {"tab_id": "tab-1"}, "root_pane": {"pane_id": "pane-shell"}}
        elif method == "pane.get":
            result = {"type": "pane_info", "pane": {"terminal_id": "term-1"}}
        else:
            result = {"type": method.replace(".", "_")}
        connection.sendall((json.dumps({"id": request["id"], "result": result}) + "\n").encode())
server.close()
socket_path.unlink(missing_ok=True)
''',
        encoding="utf-8",
    )
    path.chmod(0o700)


if __name__ == "__main__":
    unittest.main()
