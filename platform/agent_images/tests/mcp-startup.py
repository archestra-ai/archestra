"""Real pinned clients: gateway discovery precedes inference and tools execute.

Run inside a catalog image with its client name as argv[1]. Only the MCP/LLM
network boundaries are synthetic. No provider credentials or network needed.
The barrier test holds tools/list until AFTER the former startup grace, and
asserts that no tool-using inference arrives while discovery is incomplete.
"""

import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CLIENT = sys.argv.pop(1)
TOOLS = ["archestra__get_remedy_plans", "archestra__execute_remedy_plan", "archestra__yell"]
BIN = Path(os.environ.get("ARCHESTRA_TEST_WRAPPERS", "/usr/local/bin"))


class Gateway(ThreadingHTTPServer):
    def __init__(self, failure=None):
        super().__init__(("127.0.0.1", 0), Handler)
        self.failure = failure
        self.sequence = 0
        self.list_started = threading.Event()
        self.release = threading.Event()
        self.requests = []
        self.calls = []
        self.catalog_sent = False
        self.discovery_failed = threading.Event()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(405)
        self.end_headers()

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if self.path.startswith("/mcp"):
            self.mcp(request)
        elif self.path.endswith("count_tokens"):
            self.respond({"input_tokens": 10})
        elif self.path.endswith("/runtime-status"):
            self.respond({})
        elif "/messages" in self.path or "/responses" in self.path or "/chat/completions" in self.path:
            self.llm(request)
        else:
            self.respond({})

    def mcp(self, request):
        if "id" not in request:
            self.respond(None, status=202)
            return
        method = request["method"]
        if method in ("initialize", "tools/list"):
            print(f"{CLIENT}: gateway {method}", flush=True)
        if self.server.failure == method:
            self.server.discovery_failed.set()
            self.respond({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32603, "message": "Synthetic discovery failure"}})
            return
        if method == "initialize":
            result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "startup-test", "version": "1"}}
        elif method == "tools/list":
            self.server.list_started.set()
            if self.server.failure == "timeout":
                self.server.discovery_failed.set()
            if not self.server.release.wait(45):
                return
            result = {"tools": [{"name": name, "description": "Synthetic startup test tool", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}} for name in TOOLS]}
            self.server.catalog_sent = True
            print(f"{CLIENT}: gateway catalog released", flush=True)
        elif method == "tools/call":
            self.server.calls.append(request["params"]["name"])
            result = {"content": [{"type": "text", "text": "TOOL_OK"}]}
        elif method == "resources/list":
            result = {"resources": []}
        elif method == "prompts/list":
            result = {"prompts": []}
        elif method == "ping":
            result = {}
        else:
            self.respond({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not found"}})
            return
        self.respond({"jsonrpc": "2.0", "id": request["id"], "result": result})

    def llm(self, request):
        names = []
        for tool in request.get("tools", []):
            if tool.get("type") == "namespace":
                names.extend(tool["name"] + "." + item["name"] for item in tool.get("tools", []))
            else:
                names.append(tool.get("name") or tool.get("function", {}).get("name", ""))
        if not names:
            self.respond({"id": "resp_aux", "object": "response", "status": "completed", "output": [], "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}})
            return
        self.server.sequence += 1
        self.reply_id = str(self.server.sequence)
        self.server.requests.append({"names": names, "catalog_sent": self.server.catalog_sent})
        if len(self.server.requests) == 1:
            print(f"{CLIENT}: first request gateway tools: {[n for n in names if 'remedy' in n or 'yell' in n]}", flush=True)
        tool = next((name for name in names if len(self.server.calls) < len(TOOLS) and name.endswith(TOOLS[len(self.server.calls)].removeprefix("archestra__"))), None)
        if self.path.split("?", 1)[0].endswith("/messages"):
            self.anthropic(tool)
        elif self.path.endswith("/chat/completions"):
            self.chat(tool, request)
        else:
            self.send_responses(tool)

    def send_responses(self, tool):
        if tool:
            namespace, _, name = tool.rpartition(".")
            item = {"type": "function_call", "id": "fc_test_" + self.reply_id, "call_id": "call_test_" + self.reply_id, "name": name or tool, "arguments": "{}", "status": "completed"}
            if namespace:
                item["namespace"] = namespace
        else:
            item = {"type": "message", "role": "assistant", "id": "msg_test_" + self.reply_id, "status": "completed", "content": [{"type": "output_text", "text": "STARTUP_OK", "annotations": []}]}
        response = {"id": "resp_test_" + self.reply_id, "object": "response", "created_at": 1, "status": "completed", "model": "gpt-4.1", "output": [item], "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}
        events = [{"type": "response.created", "response": dict(response, status="in_progress", output=[])}, {"type": "response.output_item.added", "output_index": 0, "item": dict(item, status="in_progress", **({"arguments": ""} if tool else {"content": []}))}, {"type": "response.output_item.done", "output_index": 0, "item": item}, {"type": "response.completed", "response": response}]
        if not tool:
            events.insert(2, {"type": "response.content_part.added", "item_id": "msg_test_" + self.reply_id, "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})
            events.insert(3, {"type": "response.output_text.delta", "item_id": "msg_test_" + self.reply_id, "output_index": 0, "content_index": 0, "delta": "STARTUP_OK"})
            events.insert(4, {"type": "response.output_text.done", "item_id": "msg_test_" + self.reply_id, "output_index": 0, "content_index": 0, "text": "STARTUP_OK"})
        else:
            events.insert(2, {"type": "response.function_call_arguments.delta", "item_id": "fc_test_" + self.reply_id, "output_index": 0, "delta": "{}"})
            events.insert(3, {"type": "response.function_call_arguments.done", "item_id": "fc_test_" + self.reply_id, "output_index": 0, "arguments": "{}"})
        self.respond("".join("data: " + json.dumps(e) + "\n\n" for e in events).encode(), "text/event-stream")

    def chat(self, tool, request):
        message = {"role": "assistant", "content": "STARTUP_OK"}
        finish = "stop"
        if tool:
            message = {"role": "assistant", "content": None, "tool_calls": [{"index": 0, "id": "call_test_" + self.reply_id, "type": "function", "function": {"name": tool, "arguments": "{}"}}]}
            finish = "tool_calls"
        response = {"id": "chatcmpl-test", "object": "chat.completion", "created": 1, "model": "gpt-4.1", "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
        if request.get("stream"):
            response.update(object="chat.completion.chunk", choices=[{"index": 0, "delta": message, "finish_reason": None}])
            body = "data: " + json.dumps(response) + "\n\n"
            response["choices"] = [{"index": 0, "delta": {}, "finish_reason": finish}]
            body += "data: " + json.dumps(response) + "\n\ndata: [DONE]\n\n"
            self.respond(body.encode(), "text/event-stream")
        else:
            self.respond(response)

    def anthropic(self, tool):
        block = {"type": "tool_use", "id": "tool_test_" + self.reply_id, "name": tool, "input": {}} if tool else {"type": "text", "text": ""}
        message = {"id": "msg_test_" + self.reply_id, "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}
        events = [("message_start", {"type": "message_start", "message": message}), ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": block})]
        delta = {"type": "input_json_delta", "partial_json": "{}"} if tool else {"type": "text_delta", "text": "STARTUP_OK"}
        events.extend([("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": delta}), ("content_block_stop", {"type": "content_block_stop", "index": 0}), ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}}), ("message_stop", {"type": "message_stop"})])
        self.respond("".join("event: " + name + "\ndata: " + json.dumps(e) + "\n\n" for name, e in events).encode(), "text/event-stream")

    def respond(self, body, content_type="application/json", status=200):
        data = b"" if body is None else body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


class StartupTest(unittest.TestCase):
    def test_delegated_tui(self):
        self.run_client("one_shot")

    def test_interactive_tui(self):
        self.run_client("interactive")

    def test_resumed_delegation(self):
        self.run_client("one_shot", resume=True)

    def test_slow_discovery(self):
        self.run_client("one_shot", hold=8 if CLIENT == "codex" else 12)

    def test_gateway_discovery_timeout(self):
        self.run_client("one_shot", failure="timeout")

    def test_gateway_discovery_errors(self):
        for method in ("initialize", "tools/list"):
            with self.subTest(method=method):
                self.run_client("one_shot", failure=method)

    if CLIENT != "hermes":
        def test_plain_cli(self):
            self.run_client("one_shot", plain=True)

    def run_client(self, mode, plain=False, failure=None, hold=3, resume=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            home = root / "home"
            home.mkdir()
            server = Gateway(failure)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            env = {**os.environ, "HOME": str(home), "TERM": "xterm-256color", "PATH": str(BIN) + os.pathsep + os.environ["PATH"], "ARCHESTRA_LLM_PROXY_PROTOCOL": "anthropic" if CLIENT == "claude-code" else "openai_chat" if CLIENT == "hermes" else "openai_responses", "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime), "ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX": str(runtime / "turn"), "ARCHESTRA_AGENT_RUNTIME_MODE": mode, "ARCHESTRA_AGENT_RUNTIME_PLAIN": "1" if plain else "0", "ARCHESTRA_AGENT_RUNTIME_OPENAPPA": "1", "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "claude-sonnet-4-6" if CLIENT == "claude-code" else "gpt-6-astra" if CLIENT == "codex" else "gpt-4.1", "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "startup-test", "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID": "startup-workspace", "ARCHESTRA_AGENT_RUNTIME_TASK": "Call each recovery tool, then reply STARTUP_OK.", "ARCHESTRA_MCP_GATEWAY_URL": origin + "/mcp", "ARCHESTRA_MCP_GATEWAY_TOKEN": "synthetic-token", "OPENAI_BASE_URL": origin + "/v1", "OPENAI_API_KEY": "synthetic-key", "ANTHROPIC_BASE_URL": origin, "ANTHROPIC_AUTH_TOKEN": "synthetic-key", "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}
            try:
                for turn in range(2 if resume else 1):
                    if turn:
                        env["ARCHESTRA_AGENT_RUNTIME_CONTINUE"] = "1"
                        env["ARCHESTRA_AGENT_RUNTIME_TASK"] = "Call each recovery tool again, then reply STARTUP_OK."
                        server.requests.clear()
                        server.calls.clear()
                        server.catalog_sent = False
                        server.list_started.clear()
                        server.discovery_failed.clear()
                        server.release.clear()
                    env["ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX"] = str(runtime / f"turn-{turn}")
                    self.run_turn(root, home, runtime, env, server, mode, plain, failure, hold)
            finally:
                server.release.set()
                server.shutdown()
                server.server_close()
                for folder in (runtime / "config", runtime / "config" / "opencode"):
                    if folder.exists():
                        folder.chmod(0o755)

    def run_turn(self, root, home, runtime, env, server, mode, plain, failure, hold):
        turn_prefix = env["ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX"]
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(home)
            os.execvpe("tmux", ["tmux", "-L", root.name, "new-session", "-s", "agent", "-x", "180", "-y", "50", "/bin/bash", str(BIN / ("archestra-" + CLIENT))], env)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
        output = bytearray()
        status = None
        started = time.monotonic()
        held_since = None
        try:
            while time.monotonic() - started < 65:
                if select.select([fd], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        chunk = b""
                    output.extend(chunk)
                    if b"\x1b[6n" in chunk:
                        os.write(fd, b"\x1b[1;1R")
                    if b"\x1b[c" in chunk:
                        os.write(fd, b"\x1b[?1;2c")
                if failure and server.requests:
                    self.fail("Inference ran after required gateway discovery failed: " + repr(server.requests[:1]))
                if failure and server.discovery_failed.is_set() and time.monotonic() - started > (40 if failure == "timeout" else 12):
                    break
                if server.list_started.is_set() and not server.release.is_set():
                    held_since = held_since or time.monotonic()
                    self.assertFalse(server.requests, "Inference began while tools/list was held")
                    if not failure and time.monotonic() - held_since >= hold:
                        print(f"{CLIENT}: releasing discovery barrier", flush=True)
                        server.release.set()
                exited, child_status = os.waitpid(pid, os.WNOHANG)
                if exited:
                    status = os.waitstatus_to_exitcode(child_status)
                    break
                if mode == "one_shot" and not plain and Path(turn_prefix + ".result").exists():
                    break
                if mode == "interactive" and len(server.calls) == 3 and len(server.requests) >= 4 and (runtime / "readable-transcript.json").exists():
                    break
            details = output.decode(errors="replace")[-6000:]
            if failure:
                self.assertTrue(server.discovery_failed.is_set(), details)
                self.assertFalse(server.requests, details)
                envelope = json.loads(Path(turn_prefix + ".failure").read_text())
                self.assertIn(envelope["code"], ("mcp_startup", "codex_startup"))
                self.assertNotIn("synthetic-token", envelope["message"])
                self.assertTrue((runtime / "turn-complete.failed").exists(), details)
                self.assertFalse(Path(turn_prefix + ".result").exists(), "Failed startup was marked successful")
                print(f"{CLIENT}: {failure} failure sends no tool-using inference", flush=True)
                return
            self.assertTrue(server.list_started.is_set(), details)
            self.assertEqual(server.calls, TOOLS, details + "\nRequests: " + repr(server.requests[:2]))
            self.assertGreaterEqual(len(server.requests), 4, details)
            for request in server.requests:
                self.assertTrue(request["catalog_sent"], "Inference preceded catalog discovery")
                for tool in TOOLS:
                    self.assertTrue(any(name.endswith(tool.removeprefix("archestra__")) for name in request["names"]), (tool, request))
            if not plain:
                self.assertTrue((runtime / "readable-transcript.json").exists(), details)
            if mode == "one_shot":
                if plain:
                    self.assertEqual(status, 0, details)
                else:
                    self.assertTrue((runtime / "turn-complete").exists(), details)
                    self.assertFalse((runtime / "turn-complete.failed").exists(), details)
                    self.assertIn("STARTUP_OK", (runtime / "final-answer.txt").read_text(), details)
                    if status is None:
                        self.assertEqual(Path(turn_prefix + ".result").read_text().strip(), "0", details)
                    else:
                        self.assertEqual(status, 0, details)
            else:
                self.assertIsNone(status, "Interactive client exited")
            print(f"{CLIENT} {mode} plain={plain}: barrier, all recovery tools executed, transcript, exit OK", flush=True)
        finally:
            server.release.set()
            if status is None:
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except ProcessLookupError:
                    pass
            os.close(fd)
            subprocess.run(["tmux", "-L", root.name, "kill-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


if __name__ == "__main__":
    unittest.main()
