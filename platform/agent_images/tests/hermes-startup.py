"""Exercise the installed Hermes ACP session with a stalled package index and local APIs.

Run inside agent-hermes; no external network or provider credentials are needed.
"""

import json
import os
from pathlib import Path
import select
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class HermesStartupTest(unittest.TestCase):
    def test_task_completes_without_package_downloads(self):
        for mode in ("one_shot", "interactive"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                self.run_task(Path(directory), mode)

    def run_task(self, root, mode):
        server = RuntimeAPIs()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = f"http://127.0.0.1:{server.server_port}"
        runtime = root / "runtime"
        home = root / "home"
        home.mkdir()
        env = {
            **os.environ,
            "HOME": str(home),
            "TERM": "xterm-256color",
            "ARCHESTRA_LLM_PROXY_PROTOCOL": "openai_chat",
            "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime),
            "ARCHESTRA_AGENT_RUNTIME_MODE": mode,
            "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "gpt-4.1",
            "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "startup-test",
            "ARCHESTRA_AGENT_RUNTIME_TASK": "Use the echo tool, then reply STARTUP_OK.",
            "ARCHESTRA_MCP_GATEWAY_URL": f"{origin}/mcp",
            "ARCHESTRA_MCP_GATEWAY_TOKEN": "test-token",
            "OPENAI_BASE_URL": f"{origin}/v1",
            "OPENAI_API_KEY": "test-key",
            "PIP_INDEX_URL": f"{origin}/simple",
            "PIP_DEFAULT_TIMEOUT": "120",
            "UV_DEFAULT_INDEX": f"{origin}/simple",
            # Exercise the config opt-out even when Hermes has a writable
            # target (which overrides HERMES_DISABLE_LAZY_INSTALLS).
            "HERMES_LAZY_INSTALL_TARGET": str(root / "optional-packages"),
        }
        process = subprocess.Popen(
            ["archestra-hermes"],
            cwd=home,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        master = process.stdout.fileno()
        output = bytearray()
        started = time.monotonic()
        followup_sent = False
        try:
            transcript = runtime / "readable-transcript.json"
            while time.monotonic() - started < 25:
                if server.package_requests:
                    break
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
                if mode == "interactive" and transcript.exists():
                    try:
                        entries = json.loads(transcript.read_text())["entries"]
                    except json.JSONDecodeError:
                        continue
                    answers = count_answers(entries)
                    if answers == 1 and not followup_sent and json.loads(transcript.read_text()).get("session", {}).get("state") == "idle":
                        mailbox = runtime / "turns/startup-test.controls"
                        pending = mailbox / "abcdef.tmp"
                        pending.write_text(json.dumps({"type": "message", "text": "Reply STARTUP_OK again."}))
                        pending.rename(mailbox / "abcdef.json")
                        followup_sent = True
                    if answers == 2:
                        break
                if process.poll() is not None:
                    break
            self.assertFalse(
                server.package_requests,
                "Startup attempted an optional package download",
            )
            self.assertGreater(server.tool_calls, 0, "The real MCP tool was not executed")
            self.assertTrue(transcript.exists(), output.decode(errors="replace")[-4000:])
            entries = json.loads(transcript.read_text())["entries"]
            self.assertGreater(count_answers(entries), 0, entries)
            if mode == "one_shot":
                self.assertEqual(process.wait(timeout=5), 0)
            else:
                self.assertIsNone(
                    process.poll(), "Interactive agent must stay available for input"
                )
                self.assertEqual(count_answers(entries), 2, entries)
            print(
                f"Hermes {mode}: MCP tool and streamed answer completed "
                f"in {time.monotonic() - started:.1f}s",
                flush=True,
            )
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
            process.stdout.close()
            server.release_packages.set()
            server.shutdown()
            server.server_close()


class RuntimeAPIs(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), RequestHandler)
        self.package_requests = []
        self.tool_calls = 0
        self.release_packages = threading.Event()
        self.input_ready = threading.Event()


class RequestHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path.startswith("/simple"):
            self.server.package_requests.append(self.path)
            self.server.release_packages.wait(120)
        self.send_response(405)
        self.end_headers()

    def do_DELETE(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/mcp/runtime-status":
            self.respond({})
            if request.get("attentionState") == "input_required":
                self.server.input_ready.set()
            return
        if self.path == "/mcp":
            if "id" not in request:
                self.send_response(202)
                self.end_headers()
                return
            method = request["method"]
            if method == "tools/call":
                self.server.tool_calls += 1
            result = {
                "initialize": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "startup-test", "version": "1"},
                },
                "tools/list": {"tools": [{
                    "name": "echo",
                    "description": "Return the startup test value",
                    "inputSchema": {"type": "object", "properties": {}},
                }]},
                "tools/call": {"content": [{"type": "text", "text": "ECHO_OK"}]},
                "resources/list": {"resources": []},
                "prompts/list": {"prompts": []},
            }[method]
            self.respond({"jsonrpc": "2.0", "id": request["id"], "result": result})
            return
        tools = request.get("tools", [])
        echo = next(
            (t["function"]["name"] for t in tools
             if t["function"]["name"].endswith("echo")),
            None,
        )
        has_result = any(m.get("role") == "tool" for m in request["messages"])
        message = {"role": "assistant", "content": "STARTUP_OK"}
        finish = "stop"
        if echo and not has_result:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": "call-echo",
                    "type": "function",
                    "function": {"name": echo, "arguments": "{}"},
                }],
            }
            finish = "tool_calls"
        response = {
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-4.1",
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }
        if request.get("stream"):
            if "tool_calls" in message:
                message["tool_calls"][0]["index"] = 0
            response.update(
                object="chat.completion.chunk",
                choices=[{"index": 0, "delta": message, "finish_reason": None}],
            )
            body = "data: " + json.dumps(response) + "\n\n"
            response["choices"] = [{"index": 0, "delta": {}, "finish_reason": finish}]
            body += "data: " + json.dumps(response) + "\n\ndata: [DONE]\n\n"
            self.respond(body.encode(), "text/event-stream")
        else:
            self.respond(response)

    def respond(self, body, content_type="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def count_answers(entries):
    return sum(
        entry.get("role") == "assistant" and entry.get("text", "").strip() == "STARTUP_OK"
        for entry in entries
    )


if __name__ == "__main__":
    unittest.main()
