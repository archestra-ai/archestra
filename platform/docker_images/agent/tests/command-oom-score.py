"""The agent's shell commands take the highest OOM score; the client keeps its own.

Run inside a catalog image with its client name as argv[1]. The real pinned
client runs through its launcher against a scripted model and MCP gateway. The
model's first reply calls the client's own shell tool with a probe that records
the score of the shell running it, of a process it starts, and of every process
above it. A node that kills one process at a container's memory limit then
kills the command before the client, its launcher, tmux or PID 1.
"""

import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import socket
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
BIN = Path(os.environ.get("ARCHESTRA_TEST_WRAPPERS", "/usr/local/bin"))
GATEWAY_TOOLS = ["archestra__get_remedy_plans", "archestra__execute_remedy_plan", "archestra__yell"]
DESCRIPTION = "[[gwa1_c3ludGhldGlj.bWFya2Vy]]\nSynthetic tool" if CLIENT in ("kimi", "copilot") else "Synthetic tool"
# The tool each client runs a shell command line with, as the client declares
# it to the model.
SHELL_TOOLS = {
    "claude-code": "Bash",
    "codex": "exec_command",
    "opencode": "bash",
    "hermes": "terminal",
    "openclaw": "exec",
    "grok": "run_terminal_command",
    "kimi": "Bash",
    "copilot": "bash",
}
SHELLS = ("bash", "dash", "sh", "zsh")


def probe(report):
    """A command line, valid in any POSIX shell, that writes what it sees to `report`."""
    # Copilot's launcher raises the client's commands within 0.1 s of their
    # start; no shell startup file runs in them.
    wait = "sleep 1; " if CLIENT == "copilot" else ""
    return (
        f"{wait}r={report}; {{ "
        'echo "shell $$ $(cat /proc/$$/oom_score_adj) $(readlink /proc/$$/exe)"; '
        'echo "flags $- bash_env=${BASH_ENV-unset} at_exec=$(tr "\\000" "\\n" < /proc/$$/environ | grep -c ^BASH_ENV=) shlvl_at_exec=$(tr "\\000" "\\n" < /proc/$$/environ | sed -n s/^SHLVL=//p) stdin=$(readlink /proc/$$/fd/0) args=$(tr "\\000\\n" "  " < /proc/$$/cmdline | cut -c1-300)"; '
        "echo \"child $(sh -c 'cat /proc/$$/oom_score_adj')\"; "
        'p=$$; while p=$(ps -o ppid= -p "$p" | tr -d " "); [ -n "$p" ] && [ "$p" -gt 1 ]; do '
        'echo "parent $p $(cat /proc/$p/oom_score_adj) $(readlink /proc/$p/exe) $(tr "\\000\\n" "  " < /proc/$p/cmdline | cut -c1-200)"; '
        'done; } > "$r.tmp" 2>&1; mv "$r.tmp" "$r"; echo PROBE_RAN'
    )


class Server(ThreadingHTTPServer):
    def __init__(self, report):
        super().__init__(("127.0.0.1", 0), Handler)
        self.report = report
        self.declared = {}
        self.probed = False
        self.response_tools = {}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(405)
        self.end_headers()

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        if self.path.startswith("/mcp"):
            self.mcp(request)
        elif self.path.endswith("count_tokens"):
            self.respond({"input_tokens": 10})
        elif "/messages" in self.path or "/responses" in self.path or "/chat/completions" in self.path:
            self.llm(request)
        else:
            self.respond({})

    def mcp(self, request):
        if "id" not in request:
            self.respond(None, status=202)
            return
        method = request["method"]
        if method == "initialize":
            result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "oom-test", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": [{"name": name, "description": DESCRIPTION, "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}} for name in GATEWAY_TOOLS]}
        elif method == "tools/call":
            result = {"content": [{"type": "text", "text": "TOOL_OK"}]}
        elif method in ("resources/list", "prompts/list"):
            result = {method.split("/")[0]: []}
        elif method == "ping":
            result = {}
        else:
            self.respond({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not found"}})
            return
        self.respond({"jsonrpc": "2.0", "id": request["id"], "result": result})

    def llm(self, request):
        tools = list(request.get("tools", []))
        additional = list(request.get("additional_tools", []))
        for item in request.get("input", []):
            if isinstance(item, dict) and item.get("type") == "additional_tools":
                additional.extend(item.get("tools", []))
        for tool in additional:
            self.server.response_tools[tool.get("name")] = tool
        tools.extend(self.server.response_tools.values())
        declared = {}
        for tool in tools:
            if tool.get("type") == "namespace":
                for item in tool.get("tools", []):
                    declared[tool["name"] + "." + item["name"]] = item
            else:
                declared[tool.get("name") or tool.get("function", {}).get("name") or tool.get("type", "")] = tool
        # Side calls (titles, summaries) declare no gateway tool.
        if not any(name.endswith("yell") for name in declared):
            self.reply(None, {}, request)
            return
        self.server.declared = declared
        # Codex declares its tools in namespaces: `functions.exec_command`.
        shell = next((name for name in declared if name.rpartition(".")[2] == SHELL_TOOLS[CLIENT]), None)
        call = None
        if not self.server.probed and shell:
            self.server.probed = True
            call = (shell, arguments(declared[shell], probe(self.server.report)))
        self.reply(call, declared, request)

    def reply(self, call, declared, request):
        if self.path.split("?", 1)[0].endswith("/messages"):
            self.anthropic(call)
        elif self.path.endswith("/chat/completions"):
            self.chat(call, request)
        else:
            self.openai_responses(call)

    def openai_responses(self, call):
        if call:
            namespace, _, name = call[0].rpartition(".")
            item = {"type": "function_call", "id": "fc_probe", "call_id": "call_probe", "name": name, "arguments": json.dumps(call[1]), "status": "completed"}
            if namespace:
                item["namespace"] = namespace
        else:
            item = {"type": "message", "role": "assistant", "id": "msg_done", "status": "completed", "content": [{"type": "output_text", "text": "PROBE_OK", "annotations": []}]}
        response = {"id": "resp_" + item["id"], "object": "response", "created_at": 1, "status": "completed", "model": "gpt-4.1", "output": [item], "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}
        events = [{"type": "response.created", "response": dict(response, status="in_progress", output=[])},
                  {"type": "response.output_item.added", "output_index": 0, "item": dict(item, status="in_progress", **({"arguments": ""} if call else {"content": []}))}]
        if call:
            events += [{"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": 0, "delta": item["arguments"]},
                       {"type": "response.function_call_arguments.done", "item_id": item["id"], "output_index": 0, "arguments": item["arguments"]}]
        else:
            events += [{"type": "response.content_part.added", "item_id": item["id"], "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}},
                       {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": "PROBE_OK"},
                       {"type": "response.output_text.done", "item_id": item["id"], "output_index": 0, "content_index": 0, "text": "PROBE_OK"}]
        events += [{"type": "response.output_item.done", "output_index": 0, "item": item}, {"type": "response.completed", "response": response}]
        self.respond("".join("data: " + json.dumps(event) + "\n\n" for event in events).encode(), "text/event-stream")

    def chat(self, call, request):
        message = {"role": "assistant", "content": "PROBE_OK"}
        finish = "stop"
        if call:
            message = {"role": "assistant", "content": None, "tool_calls": [{"index": 0, "id": "call_probe", "type": "function", "function": {"name": call[0], "arguments": json.dumps(call[1])}}]}
            finish = "tool_calls"
        response = {"id": "chatcmpl-probe", "object": "chat.completion", "created": 1, "model": "gpt-4.1", "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}
        if request.get("stream"):
            response.update(object="chat.completion.chunk", choices=[{"index": 0, "delta": message, "finish_reason": None}])
            body = "data: " + json.dumps(response) + "\n\n"
            response["choices"] = [{"index": 0, "delta": {}, "finish_reason": finish}]
            body += "data: " + json.dumps(response) + "\n\ndata: [DONE]\n\n"
            self.respond(body.encode(), "text/event-stream")
        else:
            self.respond(response)

    def anthropic(self, call):
        block = {"type": "tool_use", "id": "toolu_probe", "name": call[0], "input": {}} if call else {"type": "text", "text": ""}
        delta = {"type": "input_json_delta", "partial_json": json.dumps(call[1])} if call else {"type": "text_delta", "text": "PROBE_OK"}
        message = {"id": "msg_probe", "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}
        events = [("message_start", {"type": "message_start", "message": message}),
                  ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": block}),
                  ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": delta}),
                  ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                  ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use" if call else "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 5}}),
                  ("message_stop", {"type": "message_stop"})]
        self.respond("".join("event: " + name + "\ndata: " + json.dumps(event) + "\n\n" for name, event in events).encode(), "text/event-stream")

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


def arguments(tool, command):
    """Arguments for a shell tool: the command line, and a plain value for
    every other required parameter its schema declares."""
    schema = tool.get("input_schema") or tool.get("parameters") or tool.get("function", {}).get("parameters") or {}
    properties = schema.get("properties", {})
    values = {}
    for name in set(schema.get("required", [])) | ({"command", "cmd"} & set(properties)):
        spec = properties.get(name, {})
        kind = spec.get("type")
        if name in ("command", "cmd"):
            values[name] = ["bash", "-lc", command] if kind == "array" else command
        elif "enum" in spec:
            values[name] = spec["enum"][0]
        elif kind in ("integer", "number"):
            values[name] = 60
        elif kind == "boolean":
            values[name] = False
        else:
            values[name] = "Record the OOM scores"
    return values


class CommandOomScoreTest(unittest.TestCase):
    def test_a_command_line_with_socket_input(self):
        # Node and Bun clients give a shell command a socket for its input.
        # With SHLVL below 1, Bash then reads its bashrc files in place of
        # BASH_ENV; the image's /etc/bash.bashrc runs the hook there.
        baseline = Path("/proc/self/oom_score_adj").read_text().strip()
        ours, theirs = socket.socketpair()
        with ours, theirs, tempfile.TemporaryDirectory() as home:
            env = {**os.environ, "HOME": home, "SHLVL": "0", "BASH_ENV": str(BIN / "archestra-command-oom-score.sh")}
            for shell in (["bash", "-c"], ["bash", "-lc"]):
                result = subprocess.run([*shell, "cat /proc/$$/oom_score_adj; sh -c 'cat /proc/$$/oom_score_adj'"], stdin=theirs, env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.stdout.split(), ["1000", "1000"], (shell, result.stderr))
            # A Bash script started with that input keeps the score it had.
            script = Path(home) / "script.sh"
            script.write_text("#!/bin/bash\ncat /proc/$$/oom_score_adj\n")
            script.chmod(0o755)
            result = subprocess.run([str(script)], stdin=theirs, env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.stdout.strip(), baseline, result.stderr)

    def test_delegated_tui(self):
        self.run_client(plain=False)

    if CLIENT != "hermes":
        def test_plain_cli(self):
            self.run_client(plain=True)

    if CLIENT != "copilot":
        def test_an_earlier_bash_env_still_runs(self):
            # A derived image can set its own BASH_ENV, as Lobster's worker does.
            self.run_client(plain=False, earlier_bash_env=True)

    def run_client(self, plain, earlier_bash_env=False):
        baseline = Path("/proc/self/oom_score_adj").read_text().strip()
        # A client can still be writing its state when the session ends.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            runtime = root / "runtime"
            home = root / "home"
            runtime.mkdir()
            home.mkdir()
            report = root / "report"
            server = Server(report)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            protocol = "anthropic" if CLIENT == "claude-code" else "openai_chat" if CLIENT in ("hermes", "grok", "kimi", "copilot") else "openai_responses"
            # Only this test's runtime variables: a pod's own would leak in.
            inherited = {name: value for name, value in os.environ.items() if not name.startswith("ARCHESTRA_")}
            env = {**inherited, "HOME": str(home), "TERM": "xterm-256color", "PATH": str(BIN) + os.pathsep + os.environ["PATH"],
                   "ARCHESTRA_LLM_PROXY_PROTOCOL": protocol, "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime),
                   "ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX": str(runtime / "turn"), "ARCHESTRA_AGENT_RUNTIME_MODE": "one_shot",
                   "ARCHESTRA_AGENT_RUNTIME_PLAIN": "1" if plain else "0", "ARCHESTRA_AGENT_RUNTIME_OPENAPPA": "1",
                   "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "claude-sonnet-4-6" if CLIENT == "claude-code" else "gpt-6-astra" if CLIENT == "codex" else "grok-4.7" if CLIENT == "grok" else "k3.1-pro" if CLIENT == "kimi" else "gpt-4.1",
                   "ARCHESTRA_AGENT_RUNTIME_MODEL_PROVIDER": "kimi-code" if CLIENT == "kimi" else "openai",
                   "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "oom-test", "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID": "oom-workspace",
                   "ARCHESTRA_AGENT_RUNTIME_BINDING": "synthetic-runtime-binding",
                   "ARCHESTRA_AGENT_RUNTIME_TASK": "Run the probe with your shell tool, then reply PROBE_OK.",
                   "ARCHESTRA_MCP_GATEWAY_URL": origin + "/mcp", "ARCHESTRA_MCP_GATEWAY_TOKEN": "synthetic-token",
                   "OPENAI_BASE_URL": origin + "/v1", "OPENAI_API_KEY": "synthetic-key", "ARCHESTRA_VIRTUAL_KEY": "synthetic-key",
                   "ANTHROPIC_BASE_URL": origin, "ANTHROPIC_AUTH_TOKEN": "synthetic-key",
                   "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}
            env.pop("BASH_ENV", None)
            earlier = root / "earlier-bash-env"
            if earlier_bash_env:
                # It records the score of each shell it runs in. The launcher's
                # own Bash reads it at startup too; only a command shell has 1000.
                earlier.write_text(f'cat /proc/$$/oom_score_adj >> {root / "earlier-ran"}\n')
                env["BASH_ENV"] = str(earlier)
            output, launcher = self.run_turn(root, home, env, report)
            readable = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]", "", output)
            details = readable[-4000:] + "\nDeclared tools: " + ", ".join(sorted(server.declared))
            self.assertTrue(server.probed, "The client declared no " + SHELL_TOOLS[CLIENT] + " tool\n" + details)
            self.assertTrue(report.exists(), "The probe did not run\n" + details)
            lines = report.read_text().splitlines()
            print(f"{CLIENT} plain={plain}:\n  " + "\n  ".join(lines), flush=True)
            shell = lines[0].split()
            self.assertEqual(shell[0], "shell", lines)
            self.assertEqual(shell[2], "1000", "The command did not take the highest OOM score\n" + "\n".join(lines))
            self.assertEqual(lines[2], "child 1000", "A process the command started did not inherit its score")
            parents = [line.split(maxsplit=4) for line in lines[3:]]
            # Shells between the command and the client belong to the command;
            # the first process above them is the client or its helper.
            above = [parent for parent in parents if Path(parent[3]).name not in SHELLS]
            self.assertTrue(above, lines)
            self.assertEqual(above[0][2], baseline, "The client took the command's score\n" + "\n".join(lines))
            # The process tmux started, the launcher, kept the container's score.
            self.assertEqual([parent[2] for parent in parents if parent[1] == str(launcher)], [baseline], "\n".join(lines))
            if earlier_bash_env:
                ran = (root / "earlier-ran").read_text().split() if (root / "earlier-ran").exists() else []
                self.assertIn("1000", ran, "The earlier BASH_ENV did not run in the command's shell")

    def run_turn(self, root, home, env, report):
        tmux_socket = f"{root.name}-oom"
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(home)
            os.execvpe("tmux", ["tmux", "-L", tmux_socket, "new-session", "-s", "agent", "-x", "180", "-y", "50", str(BIN / ("archestra-" + CLIENT))], env)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
        output = bytearray()
        launcher = None
        started = time.monotonic()
        try:
            while time.monotonic() - started < 90 and not report.exists():
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
                if launcher is None:
                    pane = subprocess.run(["tmux", "-L", tmux_socket, "display-message", "-p", "-t", "agent:0.0", "#{pane_pid}"], env=env, capture_output=True, text=True)
                    if pane.returncode == 0 and pane.stdout.strip():
                        launcher = int(pane.stdout.strip())
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
            return output.decode(errors="replace"), launcher
        finally:
            # The pane's process leads a session: the client and every process
            # it started end with it.
            if launcher is not None:
                subprocess.run(["pkill", "-KILL", "-s", str(launcher)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            subprocess.run(["tmux", "-L", tmux_socket, "kill-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
            os.close(fd)


if __name__ == "__main__":
    unittest.main()
