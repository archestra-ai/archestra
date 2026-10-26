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
# The gateway puts an attestation marker in front of each description; the LLM
# proxy resolves a client's renamed tool by it, so it must reach the model.
DESCRIPTION = "[[gwa1_c3ludGhldGlj.bWFya2Vy]]\nSynthetic startup test tool" if CLIENT == "kimi" else "Synthetic startup test tool"
STEER = "STEER_MARKER mention the steer in the reply"
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
        self.binding_headers = []
        self.prompts = []
        # Grok side calls (no gateway tools) that carry the task text.
        self.aux_task_requests = []
        # Seconds each tool-using model reply waits, so a steer lands mid-turn.
        self.delay = 0
        self.descriptions = {}

    def inference(self):
        """Every model request that worked on the task, side calls included."""
        return self.requests + self.aux_task_requests


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(405)
        self.end_headers()

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if self.path in ("/runtime-status", "/mcp/runtime-status"):
            # Native attention callbacks are not model/MCP execution traffic.
            self.respond({})
        elif self.path.startswith("/mcp"):
            self.record_runtime_binding()
            self.mcp(request)
        elif self.path.endswith("count_tokens"):
            self.respond({"input_tokens": 10})
        elif "/messages" in self.path or "/responses" in self.path or "/chat/completions" in self.path:
            self.record_runtime_binding()
            self.llm(request)
        else:
            self.respond({})

    def record_runtime_binding(self):
        self.server.binding_headers.append((self.path, self.headers.get("X-Archestra-Runtime-Binding")))

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
            if self.server.failure == "empty":
                self.server.discovery_failed.set()
                self.server.release.set()
            if not self.server.release.wait(45):
                return
            result = {"tools": [{"name": name, "description": DESCRIPTION, "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}} for name in ([] if self.server.failure == "empty" else TOOLS)]}
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
                self.server.descriptions[names[-1]] = tool.get("description") or tool.get("function", {}).get("description")
        if self.server.delay and names:
            time.sleep(self.server.delay)
        if CLIENT == "grok" and not any(name.endswith(TOOLS[0].removeprefix("archestra__")) for name in names):
            # Session summaries and other side calls declare no gateway tool.
            # One that carries the task still counts as inference for the
            # barrier: it must not run before the catalog is loaded.
            if "recovery tool" in json.dumps(request.get("messages") or ""):
                self.server.aux_task_requests.append({"names": names, "catalog_sent": self.server.catalog_sent})
            self.reply_id = "aux"
            self.chat(None, request)
            return
        if not names:
            self.respond({"id": "resp_aux", "object": "response", "status": "completed", "output": [], "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}})
            return
        self.server.sequence += 1
        self.reply_id = str(self.server.sequence)
        self.server.requests.append({"names": names, "catalog_sent": self.server.catalog_sent})
        self.server.prompts.append(json.dumps(request.get("messages") or request.get("input") or ""))
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
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def stop_retained_client(tmux, env):
    # A retained TUI has a separate foreground process group. Killing
    # only tmux leaves that client writing into the temporary home.
    pane = subprocess.run(tmux + ["display-message", "-p", "-t", "agent:0.0", "#{pane_pid}"], env=env, capture_output=True, text=True)
    if pane.returncode == 0:
        foreground = subprocess.run(["ps", "-o", "tpgid=", "-p", pane.stdout.strip()], capture_output=True, text=True)
        if foreground.returncode == 0:
            group = int(foreground.stdout.strip() or "-1")
            if group > 0 and group != os.getpgrp():
                try:
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass


class StartupTest(unittest.TestCase):
    if CLIENT == "hermes":
        def test_agent_build_starts_discovery(self):
            # Exercise the real agent builder before any background thread exists.
            server = Gateway()
            server.release.set()
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                with tempfile.TemporaryDirectory() as directory:
                    origin = f"http://127.0.0.1:{server.server_port}"
                    Path(directory, "config.yaml").write_text(json.dumps({
                        "model": {"default": "gpt-4.1", "provider": "openai", "base_url": origin + "/v1"},
                        "mcp_servers": {"archestra": {"url": origin + "/mcp"}},
                        "mcp_discovery_timeout": 10,
                    }))
                    result = subprocess.run(
                        ["/opt/hermes/.venv/bin/python", "-c",
                         "from tui_gateway.server import _make_agent; "
                         "_make_agent('startup-test', 'test-key', model_override='gpt-4.1', provider_override='openai')"],
                        env={**os.environ, "HERMES_HOME": directory, "OPENAI_API_KEY": "test-key", "OPENAI_BASE_URL": origin + "/v1"},
                        capture_output=True, text=True, timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertTrue(server.catalog_sent)
                    self.assertFalse(server.inference())
            finally:
                server.shutdown()
                server.server_close()

    def test_missing_runtime_binding_is_fail_closed(self):
        self.run_client("one_shot", missing_binding=True)

    def test_delegated_tui(self):
        self.run_client("one_shot")

    def test_interactive_tui(self):
        self.run_client("interactive")

    def test_resumed_delegation(self):
        self.run_client("one_shot", resume=True)

    def test_idle_interactive_resume(self):
        self.run_client("one_shot", resume=True, idle_resume=True)

    def test_slow_discovery(self):
        self.run_client("one_shot", hold=8 if CLIENT == "codex" else 12)

    def test_gateway_discovery_timeout(self):
        self.run_client("one_shot", failure="timeout")

    def test_gateway_discovery_errors(self):
        for method in ("initialize", "tools/list"):
            with self.subTest(method=method):
                self.run_client("one_shot", failure=method)

    if CLIENT in ("claude-code", "kimi"):
        def test_empty_gateway_catalog(self):
            self.run_client("one_shot", failure="empty")

    if CLIENT == "claude-code":
        def test_large_multiline_task(self):
            # tmux refuses a single command above its ~16 KB message limit.
            for size in (17_000, 100_000):
                with self.subTest(size=size):
                    self.run_client("one_shot", task_size=size)

        def test_task_submission_failure(self):
            self.run_client("one_shot", submission_failure=True)

    if CLIENT != "hermes":
        def test_plain_cli(self):
            self.run_client("one_shot", plain=True)

    if CLIENT == "kimi":
        def test_project_mcp_configs_are_ignored(self):
            # A cloned repository's MCP files must neither start a server nor
            # replace the gateway, although the working directory is trusted.
            self.run_client("one_shot", planted=True)

        def test_mid_turn_steer(self):
            # The runtime types a steer and Enter while the model works; it
            # must reach the running turn, not wait for the next one.
            self.run_client("one_shot", steer=True)

    def run_client(self, mode, plain=False, failure=None, hold=3, resume=False, idle_resume=False, missing_binding=False, task_size=0, submission_failure=False, steer=False, planted=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            home = root / "home"
            home.mkdir()
            if planted:
                # The client's working directory is the project: its root
                # .mcp.json and .kimi-code/mcp.json, one of them shadowing the
                # gateway's server name. Either starting leaves a marker.
                (home / ".kimi-code").mkdir()
                for path, name in ((home / ".mcp.json", "planted"), (home / ".kimi-code" / "mcp.json", "archestra")):
                    marker = root / f"started-{name}"
                    path.write_text(json.dumps({"mcpServers": {name: {"command": "/bin/sh", "args": ["-c", f"touch {marker}; exec sleep 60"]}}}))
            if CLIENT == "codex":
                # A cached newer release is what raises Codex's update prompt,
                # which would hold the pinned image's TUI before the turn.
                (runtime / "codex").mkdir()
                (runtime / "codex" / "version.json").write_text(json.dumps({"latest_version": "999.0.0", "last_checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
            server = Gateway(failure)
            server.delay = 3 if steer else 0
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            env = {**os.environ, "HOME": str(home), "TERM": "xterm-256color", "PATH": str(BIN) + os.pathsep + os.environ["PATH"], "ARCHESTRA_LLM_PROXY_PROTOCOL": "anthropic" if CLIENT == "claude-code" else "openai_chat" if CLIENT in ("hermes", "grok", "kimi") else "openai_responses", "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime), "ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX": str(runtime / "turn"), "ARCHESTRA_AGENT_RUNTIME_MODE": mode, "ARCHESTRA_AGENT_RUNTIME_PLAIN": "1" if plain else "0", "ARCHESTRA_AGENT_RUNTIME_OPENAPPA": "1", "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "claude-sonnet-4-6" if CLIENT == "claude-code" else "gpt-6-astra" if CLIENT == "codex" else "grok-4.7" if CLIENT == "grok" else "k3.1-pro" if CLIENT == "kimi" else "gpt-4.1", "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "startup-test", "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID": "startup-workspace", "ARCHESTRA_AGENT_RUNTIME_TASK": "Call each recovery tool, then reply STARTUP_OK.", "ARCHESTRA_MCP_GATEWAY_URL": origin + "/mcp", "ARCHESTRA_MCP_GATEWAY_TOKEN": "synthetic-token", "OPENAI_BASE_URL": origin + "/v1", "OPENAI_API_KEY": "synthetic-key", "ANTHROPIC_BASE_URL": origin, "ANTHROPIC_AUTH_TOKEN": "synthetic-key", "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "ARCHESTRA_AGENT_RUNTIME_MODEL_PROVIDER": "kimi" if CLIENT == "kimi" else "openai"}
            if submission_failure:
                # Only the task paste fails; the pane and MCP status probes work.
                shim = root / "shim"
                shim.mkdir()
                (shim / "tmux").write_text('#!/bin/sh\ncase "$1" in load-buffer|paste-buffer) exit 1;; esac\nexec /usr/bin/tmux "$@"\n')
                (shim / "tmux").chmod(0o755)
                env["PATH"] = str(shim) + os.pathsep + env["PATH"]
            if task_size:
                line = "Context line that must reach the model unchanged.\n"
                env["ARCHESTRA_AGENT_RUNTIME_TASK"] += "\n" + line * (task_size // len(line)) + "TASK_TAIL_MARKER"
            try:
                for turn in range(2 if resume else 1):
                    if missing_binding:
                        env.pop("ARCHESTRA_AGENT_RUNTIME_BINDING", None)
                    else:
                        env["ARCHESTRA_AGENT_RUNTIME_BINDING"] = f"synthetic-runtime-binding-{turn}"
                    if turn:
                        env["ARCHESTRA_AGENT_RUNTIME_CONTINUE"] = "1"
                        env["ARCHESTRA_AGENT_RUNTIME_TASK"] = "Call each recovery tool again, then reply STARTUP_OK."
                        server.requests.clear()
                        server.aux_task_requests.clear()
                        server.calls.clear()
                        server.catalog_sent = False
                        server.list_started.clear()
                        server.discovery_failed.clear()
                        server.binding_headers.clear()
                        server.release.clear()
                    env["ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX"] = str(runtime / f"turn-{turn}")
                    turn_mode = "interactive" if turn and idle_resume else mode
                    if turn and idle_resume:
                        env["ARCHESTRA_AGENT_RUNTIME_MODE"] = turn_mode
                        env["ARCHESTRA_AGENT_RUNTIME_TASK"] = ""
                    if missing_binding:
                        env["ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX"] = str(runtime / "missing-binding")
                        refused = subprocess.run(["/bin/bash", str(BIN / ("archestra-" + CLIENT))], cwd=home, env=env, capture_output=True, timeout=10)
                        self.assertNotEqual(refused.returncode, 0)
                        self.assertIn(b"OpenAPPA runtime binding is required", refused.stdout + refused.stderr)
                        self.assertFalse(server.requests, "A runtime without its binding submitted inference")
                        self.assertFalse(server.binding_headers, "A runtime without its binding contacted the gateway")
                        self.assertFalse((runtime / "missing-binding.result").exists(), "A runtime without its binding was marked successful")
                    else:
                        self.run_turn(root, home, runtime, env, server, turn_mode, plain, failure, hold, idle=bool(turn and idle_resume), submission_failure=submission_failure, steer=steer)
                        if planted:
                            self.assertEqual(sorted(path.name for path in root.glob("started-*")), [], "A project MCP server was started")
                            names = {name for request in server.requests for name in request["names"]}
                            self.assertFalse({name for name in names if "planted" in name}, names)
            finally:
                server.release.set()
                server.shutdown()
                server.server_close()
                for folder in (runtime / "config", runtime / "config" / "opencode"):
                    if folder.exists():
                        folder.chmod(0o755)

    def run_turn(self, root, home, runtime, env, server, mode, plain, failure, hold, idle=False, submission_failure=False, steer=False):
        turn_prefix = env["ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX"]
        # A previous daemon can still be shutting down when a resumed turn
        # starts. Keep native session storage, but use a fresh socket per turn.
        tmux_socket = f"{root.name}-{Path(turn_prefix).name}"
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(home)
            os.execvpe("tmux", ["tmux", "-L", tmux_socket, "new-session", "-s", "agent", "-x", "180", "-y", "50", "/bin/bash", str(BIN / ("archestra-" + CLIENT))], env)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
        output = bytearray()
        status = None
        started = time.monotonic()
        held_since = None
        steering = None
        try:
            while time.monotonic() - started < (95 if failure else 65):
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
                if idle and server.inference():
                    self.fail("Idle resume submitted inference without a prompt")
                if (failure or submission_failure) and server.inference():
                    self.fail("Inference ran after required gateway discovery failed: " + repr(server.inference()[:1]))
                if failure and server.discovery_failed.is_set():
                    # Watch for a forbidden model call at least this long, then give
                    # clients whose own connect retries report later (Hermes takes
                    # ~10s after a gateway error) bounded time to write the failure.
                    observed = 40 if failure in ("timeout", "empty") else 12
                    elapsed = time.monotonic() - started
                    # The envelope is published before the helper writes its
                    # completion marker. Wait for both before asserting on them.
                    completed_failure = Path(turn_prefix + ".failure").exists() and (runtime / "turn-complete.failed").exists()
                    if elapsed > observed and (completed_failure or elapsed > observed + 30):
                        break
                if server.list_started.is_set() and not server.release.is_set():
                    held_since = held_since or time.monotonic()
                    self.assertFalse(server.inference(), "Inference began while tools/list was held")
                    if not failure and time.monotonic() - held_since >= hold:
                        print(f"{CLIENT}: releasing discovery barrier", flush=True)
                        server.release.set()
                if idle and time.monotonic() - started > hold + 5 and (not server.list_started.is_set() or server.catalog_sent):
                    break
                if steer and steering is None and server.requests:
                    # The command Agent Runtime runs for tmux_keys steering.
                    tmux = f"tmux -L {tmux_socket} send-keys -t agent"
                    steering = subprocess.Popen(["/bin/sh", "-c", f"{tmux} -l -- '{STEER}' && sleep 1 && {tmux} Enter"], env=env)
                exited, child_status = os.waitpid(pid, os.WNOHANG)
                if exited:
                    status = os.waitstatus_to_exitcode(child_status)
                    break
                if mode == "one_shot" and not plain and Path(turn_prefix + ".result").exists():
                    break
                if mode == "interactive" and len(server.calls) == 3 and len(server.requests) >= 4 and (runtime / "readable-transcript.json").exists():
                    break
            details = output.decode(errors="replace")[-6000:]
            self.assertNotIn("Update available", output.decode(errors="replace"), details)
            for path, binding in server.binding_headers:
                self.assertEqual(binding, env["ARCHESTRA_AGENT_RUNTIME_BINDING"], f"{path}: missing or stale workspace binding")
            if failure:
                self.assertTrue(server.discovery_failed.is_set(), details)
                self.assertFalse(server.inference(), details)
                self.assertTrue(Path(turn_prefix + ".failure").exists(), details)
                envelope = json.loads(Path(turn_prefix + ".failure").read_text())
                self.assertIn(envelope["code"], ("mcp_startup", "codex_startup"))
                self.assertNotIn("synthetic-token", envelope["message"])
                self.assertTrue((runtime / "turn-complete.failed").exists(), details)
                self.assertFalse(Path(turn_prefix + ".result").exists(), "Failed startup was marked successful")
                print(f"{CLIENT}: {failure} failure sends no tool-using inference", flush=True)
                return
            if submission_failure:
                self.assertTrue(server.catalog_sent, details)
                self.assertFalse(server.inference(), details)
                envelope = json.loads(Path(turn_prefix + ".failure").read_text())
                self.assertEqual(envelope["code"], "task_submission", details)
                self.assertNotIn("MCP", envelope["message"])
                self.assertEqual((runtime / "final-answer.txt").read_text().strip(), envelope["message"])
                self.assertTrue((runtime / "turn-complete.failed").exists(), details)
                self.assertFalse(Path(turn_prefix + ".result").exists(), "Unsubmitted task was marked successful")
                print(f"{CLIENT}: task submission failure is reported as such", flush=True)
                return
            if idle:
                # Some clients connect lazily when the next prompt arrives.
                # Claude's terminal gate must finish even for an idle restore.
                if CLIENT == "claude-code" or server.list_started.is_set():
                    self.assertTrue(server.catalog_sent, details)
                self.assertFalse(server.inference(), details)
                self.assertFalse(server.calls, details)
                self.assertIsNone(status, "Idle resumed client exited")
                print(f"{CLIENT}: saved session restored with no automatic inference", flush=True)
                return
            self.assertTrue(server.list_started.is_set(), details)
            self.assertEqual(server.calls, TOOLS, details + "\nRequests: " + repr(server.requests[:2]))
            self.assertGreaterEqual(len(server.requests), 4, details)
            for request in server.aux_task_requests:
                self.assertTrue(request["catalog_sent"], "A side call worked on the task before catalog discovery")
            if steer:
                steered = [index for index, prompt in enumerate(server.prompts) if STEER in prompt]
                self.assertTrue(steered, details)
                # A steer queued for the next turn would first reach the model
                # after the closing reply, in a fifth request.
                self.assertLess(steered[0], len(TOOLS), "The steer waited for the next turn")
            if CLIENT == "kimi":
                for tool in TOOLS:
                    declared = [description for name, description in server.descriptions.items() if name.endswith(tool.removeprefix("archestra__"))]
                    self.assertEqual(declared, [DESCRIPTION], (tool, server.descriptions))
            for request in server.requests:
                self.assertTrue(request["catalog_sent"], "Inference preceded catalog discovery")
                if CLIENT == "grok":
                    # The wire adapter shows the model the gateway tools, never
                    # Grok's own dispatcher pair.
                    self.assertFalse({"search_tool", "use_tool"} & set(request["names"]), request)
                for tool in TOOLS:
                    self.assertTrue(any(name.endswith(tool.removeprefix("archestra__")) for name in request["names"]), (tool, request))
            if not plain:
                self.assertTrue((runtime / "readable-transcript.json").exists(), details)
            if len(env["ARCHESTRA_AGENT_RUNTIME_TASK"]) > 16_000:
                # Every byte and line feed of the task reaches the model.
                self.assertIn(json.dumps(env["ARCHESTRA_AGENT_RUNTIME_TASK"])[1:-1], server.prompts[0], "The large task was altered")
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
            stop_retained_client(["tmux", "-L", tmux_socket], env)
            server.release.set()
            if status is None:
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except ProcessLookupError:
                    pass
            os.close(fd)
            subprocess.run(["tmux", "-L", tmux_socket, "kill-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


if __name__ == "__main__":
    unittest.main()
