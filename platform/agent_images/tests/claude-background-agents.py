"""Real pinned Claude Code: a delegated run outlives its first Stop while a
background subagent runs, and completes with the answer from the turn that
reads the subagent's report.

Run inside the Claude Code image. Only the MCP/LLM network boundaries are
synthetic: a scripted Anthropic Messages endpoint launches one background
Agent, answers its subagent after a delay, and ends both main turns.
"""

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

# Reuse the MCP gateway and SSE helpers of the startup test.
sys.argv.insert(1, "claude-code")
spec = importlib.util.spec_from_file_location("mcp_startup", Path(__file__).with_name("mcp-startup.py"))
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)

BIN = startup.BIN
WAITING = "Waiting for the background agent."
DONE = "All agents reported."
SUBAGENT_DELAY = 5
SUBAGENT_PROMPT = "Reply REVIEW_DONE."
TASK = "Start a background review agent, then report its result."


class Upstream(startup.Gateway):
    def __init__(self, log):
        super().__init__()
        self.RequestHandlerClass = Handler
        # No discovery barrier: this test is about the end of the run.
        self.release.set()
        self.log = log
        self.attention = []
        self.agent_tool = None
        self.launch_result = ""
        self.lock = threading.Lock()


class Handler(startup.Handler):
    def do_POST(self):
        if self.path in ("/runtime-status", "/mcp/runtime-status"):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            self.server.attention.append({"at": time.time(), **body})
            self.respond({})
            return
        super().do_POST()

    def llm(self, request):
        names = [tool.get("name", "") for tool in request.get("tools", [])]
        messages = request.get("messages", [])
        text = json.dumps(messages)
        agent_use = "toolu_background_agent"
        # Only the main loop declares main-thread tools next to Agent. Side
        # requests copy its conversation with a smaller tool set; they and the
        # subagent get plain text, so no other request can launch a tool.
        if "Agent" in names and "AskUserQuestion" in names:
            if "<task-notification>" in json.dumps(messages[-1:]):
                role, reply = "main:notification", ("text", DONE)
            elif agent_use in text:
                role, reply = "main:launched", ("text", WAITING)
                self.server.launch_result = launch_result(messages, agent_use)
            else:
                agent = next(tool for tool in request["tools"] if tool.get("name") == "Agent")
                arguments = {"description": "Background review", "prompt": SUBAGENT_PROMPT, "subagent_type": "general-purpose"}
                # With the fork gate on, the client omits this parameter and
                # runs every subagent in the background.
                if "run_in_background" in agent["input_schema"].get("properties", {}):
                    arguments["run_in_background"] = True
                self.server.agent_tool = agent
                role, reply = "main:start", ("tool_use", agent_use, arguments)
        elif SUBAGENT_PROMPT in text and TASK not in text:
            role, reply = "subagent", ("text", "REVIEW_DONE")
        else:
            role, reply = "other", ("text", "OK")
        with self.server.lock:
            self.server.sequence += 1
            self.reply_id = str(self.server.sequence)
            entry = {"at": time.time(), "role": role, "tools": len(names), "first_tools": names[:4], "messages": len(messages)}
            self.server.requests.append(entry)
            with open(self.server.log, "a") as log:
                log.write(json.dumps(entry) + "\n")
        print(f"claude-code: {role} request", flush=True)
        if role == "subagent":
            time.sleep(SUBAGENT_DELAY)
        if reply[0] == "tool_use":
            self.tool_use(reply[1], reply[2])
        else:
            self.text(reply[1])

    def tool_use(self, tool_id, arguments):
        block = {"type": "tool_use", "id": tool_id, "name": "Agent", "input": {}}
        self.stream(block, {"type": "input_json_delta", "partial_json": json.dumps(arguments)}, "tool_use")

    def text(self, text):
        self.stream({"type": "text", "text": ""}, {"type": "text_delta", "text": text}, "end_turn")

    def stream(self, block, delta, stop_reason):
        message = {"id": "msg_test_" + self.reply_id, "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 0}}
        events = [
            ("message_start", {"type": "message_start", "message": message}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": block}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": delta}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": 5}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        self.respond("".join("event: " + name + "\ndata: " + json.dumps(e) + "\n\n" for name, e in events).encode(), "text/event-stream")


def launch_result(messages, tool_use_id):
    for message in messages:
        if isinstance(message.get("content"), list):
            for block in message["content"]:
                if block.get("type") == "tool_result" and block.get("tool_use_id") == tool_use_id:
                    content = block.get("content")
                    return content if isinstance(content, str) else "\n".join(item.get("text", "") for item in content or [] if isinstance(item, dict))
    return ""


class BackgroundAgentsTest(unittest.TestCase):
    def test_delegated_run_waits_for_background_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            home = root / "home"
            home.mkdir()
            evidence = Path(os.environ.get("ARCHESTRA_TEST_EVIDENCE_DIR", root))
            server = Upstream(evidence / "claude-background-agents-upstream.jsonl")
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            env = {**os.environ, "HOME": str(home), "TERM": "xterm-256color", "PATH": str(BIN) + os.pathsep + os.environ["PATH"], "ARCHESTRA_LLM_PROXY_PROTOCOL": "anthropic", "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime), "ARCHESTRA_AGENT_RUNTIME_MODE": "one_shot", "ARCHESTRA_AGENT_RUNTIME_OPENAPPA": "1", "ARCHESTRA_AGENT_RUNTIME_BINDING": "synthetic-runtime-binding", "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "claude-sonnet-4-6", "ARCHESTRA_AGENT_RUNTIME_TASK_ID": "background-test", "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID": "background-workspace", "ARCHESTRA_AGENT_RUNTIME_TASK": TASK, "ARCHESTRA_MCP_GATEWAY_URL": origin + "/mcp", "ARCHESTRA_MCP_GATEWAY_TOKEN": "synthetic-token", "ANTHROPIC_BASE_URL": origin, "ANTHROPIC_AUTH_TOKEN": "synthetic-key", "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}
            for name in ("ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX", "ARCHESTRA_AGENT_RUNTIME_CONTINUE", "ARCHESTRA_AGENT_RUNTIME_CLAUDE_AUTH", "ARCHESTRA_AGENT_RUNTIME_PLAIN", "ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT", "TMUX", "TMUX_PANE"):
                env.pop(name, None)
            socket = f"background-{root.name}"
            pane_log = root / "pane.log"
            status_file = root / "status"
            tmux = ["tmux", "-L", socket]
            try:
                subprocess.run(tmux + ["new-session", "-d", "-s", "agent", "-x", "180", "-y", "50", "-c", str(home), "/bin/bash", "-c", f'"$0"; echo $? > {status_file}; sleep 600', str(BIN / "archestra-claude-code")], env=env, check=True)
                subprocess.run(tmux + ["pipe-pane", "-t", "agent", "cat >> " + str(pane_log)], env=env, check=True)
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline and not status_file.exists():
                    time.sleep(0.2)
                output = pane_log.read_text(errors="replace") if pane_log.exists() else ""
                roles = [request["role"] for request in server.requests]
                details = output[-4000:] + "\nRequests: " + repr(roles) + "\nLaunch result: " + server.launch_result
                (evidence / "claude-background-agents-launch.json").write_text(json.dumps({"agent_tool": server.agent_tool, "launch_result": server.launch_result}, indent=2))
                self.assertTrue(status_file.exists(), "The wrapper did not exit\n" + details)
                answer = output.split("===ARCHESTRA-FINAL-ANSWER===", 1)[-1].split("===ARCHESTRA-FINAL-ANSWER-END===", 1)[0].strip()
                print("claude-code: final answer: " + answer, flush=True)
                self.assertEqual(status_file.read_text().strip(), "0", details)
                # Without a background launch this scenario cannot fail.
                self.assertIn("Async agent launched", server.launch_result, details)
                self.assertEqual([role for role in roles if role.startswith("main:")], ["main:start", "main:launched", "main:notification"], details)
                self.assertIn("subagent", roles, details)
                self.assertEqual(answer, DONE, details)
                self.assertFalse([report for report in server.attention if report.get("attentionState") == "input_required"], details)
                print("claude-code: delegated run completed after its background agent reported", flush=True)
            finally:
                subprocess.run(tmux + ["kill-session", "-t", "agent"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
