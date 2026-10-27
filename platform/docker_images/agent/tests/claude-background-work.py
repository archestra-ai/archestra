"""Real Claude Code keeps a delegated task open until background work is consumed.

Run inside the maintained Claude image. Only MCP/model HTTP responses are
scripted; the native Bash tool, process, hooks, and retained TUI are real.
Set ARCHESTRA_TEST_BACKGROUND_SECONDS=600 for the ten-minute local check.
"""

import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import unittest


spec = importlib.util.spec_from_file_location(
    "background_agents", Path(__file__).with_name("claude-background-agents.py")
)
background = importlib.util.module_from_spec(spec)
spec.loader.exec_module(background)
BIN = background.BIN
WAITING = "The review is running. I will wait for it to finish."
DONE = "The background review finished and its result was handled."
CANCELLED = "The background review was cancelled."
TASK = "Run a background review, wait for its result, then report the outcome."
MONITOR_PROMPT = "The scheduled review check fired. Cancel this monitor and report its outcome."
CHILD_PROMPT = "Run the nested background shell review, read its result, then report CHILD_REVIEW_DONE."
CHILD_DONE = "CHILD_REVIEW_DONE: REVIEW_DONE was read from the shell output."
DELAY = float(os.environ.get("ARCHESTRA_TEST_BACKGROUND_SECONDS", "8"))


class Upstream(background.Upstream):
    def __init__(self, evidence, finished, kind):
        super().__init__(evidence / "upstream.jsonl")
        self.RequestHandlerClass = NestedHandler if kind.startswith("nested") else Handler
        self.evidence = evidence
        self.finished = finished
        self.release_review = finished.with_name("release-review")
        self.kind = kind
        self.delay = {"shell-fast": 0.1, "shell-stop": 60, "nested-fast": 0.1}.get(kind, DELAY)
        # Give the ten-minute test margin beyond its review duration. Claude
        # enforces the Bash timeout even when run_in_background is true.
        self.timeout = max(600000, int((self.delay + 60) * 1000))
        self.answer = CANCELLED if kind == "shell-stop" else DONE
        self.notified_at = None
        self.consumed_at = None
        self.consumed_result = ""
        self.monitor_fired = False
        self.stop_result = ""
        self.agent_launch_result = ""
        self.child_result = ""
        self.parent_notifications = []
        self.release_final = threading.Event()

    def review_command(self):
        script = "from pathlib import Path\nimport time\n"
        if self.kind in ("shell-fast", "nested-fast"):
            script += f"while not Path({str(self.release_review)!r}).exists(): time.sleep(0.01)\n"
        script += (
            f"time.sleep({self.delay!r})\n"
            f"Path({str(self.finished)!r}).write_text('REVIEW_DONE')\n"
            "print('REVIEW_DONE')\n"
        )
        return "python3 -c " + shlex.quote(script)


class Handler(background.Handler):
    def llm(self, request):
        names = [tool.get("name", "") for tool in request.get("tools", [])]
        messages = request.get("messages", [])
        text = json.dumps(messages)
        tool_id = "toolu_background_review"
        if "Bash" in names and "AskUserQuestion" in names:
            (self.server.evidence / "tools.json").write_text(
                json.dumps(request.get("tools", []), indent=2)
            )
            if self.server.kind == "cron":
                role, reply = self.cron_reply(messages, text)
            elif "toolu_stop_review" in text:
                self.server.stop_result = background.launch_result(messages, "toolu_stop_review")
                self.server.consumed_at = time.time()
                role, reply = "main:consumed", ("text", self.server.answer)
            elif "toolu_read_review" in text:
                self.server.consumed_result = background.launch_result(messages, "toolu_read_review")
                self.server.consumed_at = time.time()
                role, reply = "main:consumed", ("text", DONE)
            elif "<task-notification>" in json.dumps(messages[-1:]):
                self.server.notified_at = time.time()
                (self.server.evidence / "notification.json").write_text(json.dumps(messages[-1:], indent=2))
                output_file = re.search(r"<output-file>(.*?)</output-file>", json.dumps(messages[-1:])).group(1)
                role, reply = "main:notification", (
                    "tool_use", "Read", "toolu_read_review", {"file_path": output_file},
                )
            elif tool_id in text:
                self.server.launch_result = background.launch_result(messages, tool_id)
                if self.server.kind == "shell-stop":
                    launched = next(
                        hook["payload"] for hook in read_hooks(self.server.evidence)
                        if hook["payload"].get("hook_event_name") == "PostToolUse"
                        and hook["payload"].get("tool_name") == "Bash"
                    )
                    task_id = launched["tool_response"]["backgroundTaskId"]
                    role, reply = "main:stop", (
                        "tool_use", "TaskStop", "toolu_stop_review", {"task_id": task_id},
                    )
                else:
                    role, reply = "main:waiting", ("text", WAITING)
            else:
                arguments = {
                    "command": self.server.review_command(),
                    "description": "Run the background review",
                    "run_in_background": True,
                    "timeout": self.server.timeout,
                }
                role, reply = "main:start", ("tool_use", "Bash", tool_id, arguments)
        else:
            role, reply = "other", ("text", "OK")
        self.emit_reply(role, reply)

    def emit_reply(self, role, reply):
        with self.server.lock:
            self.server.sequence += 1
            self.reply_id = str(self.server.sequence)
            entry = {"at": time.time(), "role": role}
            self.server.requests.append(entry)
            with self.server.log.open("a") as log:
                log.write(json.dumps(entry) + "\n")
        print(f"claude-code: {role}", flush=True)
        if (role == "main:waiting" and self.server.kind == "shell-fast") or (
            role == "child:waiting" and self.server.kind == "nested-fast"
        ):
            # Hold fast jobs until their launch acknowledgement reaches the
            # model, then finish them before the waiting response reaches Stop.
            self.server.release_review.touch()
            deadline = time.monotonic() + 10
            while not self.server.finished.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            time.sleep(0.3)
        if role == "main:consumed":
            self.server.release_final.wait(10)
        if reply[0] == "tool_use":
            self.stream(
                {"type": "tool_use", "id": reply[2], "name": reply[1], "input": {}},
                {"type": "input_json_delta", "partial_json": json.dumps(reply[3])},
                "tool_use",
            )
        else:
            self.text(reply[1])

    def cron_reply(self, messages, text):
        if "toolu_delete_monitor" in text:
            return "main:done", ("text", DONE)
        if MONITOR_PROMPT in text and "toolu_create_monitor" in text:
            # Only an actual scheduled user message can match here: the
            # creation tool arguments also contain the prompt, so inspect
            # the incoming user-message blocks separately.
            fired = any(
                message.get("role") == "user" and MONITOR_PROMPT in json.dumps(message.get("content"))
                for message in messages
            )
            if fired:
                self.server.monitor_fired = True
                (self.server.evidence / "cron-wakeup.json").write_text(json.dumps(messages[-1:], indent=2))
                hooks = read_hooks(self.server.evidence)
                created = next(
                    hook["payload"] for hook in hooks
                    if hook["payload"].get("hook_event_name") == "PostToolUse"
                    and hook["payload"].get("tool_name") == "CronCreate"
                )
                job_id = created["tool_response"]["id"]
                return "main:delete", (
                    "tool_use", "CronDelete", "toolu_delete_monitor", {"id": job_id},
                )
        if "toolu_create_monitor" in text:
            self.server.launch_result = background.launch_result(messages, "toolu_create_monitor")
            return "main:waiting", ("text", WAITING)
        return "main:start", (
            "tool_use", "CronCreate", "toolu_create_monitor",
            {"cron": "* * * * *", "prompt": MONITOR_PROMPT, "recurring": True},
        )


class NestedHandler(Handler):
    def llm(self, request):
        names = [tool.get("name", "") for tool in request.get("tools", [])]
        messages = request.get("messages", [])
        text = json.dumps(messages)
        latest = json.dumps(messages[-1:])
        if "Agent" in names and "AskUserQuestion" in names:
            (self.server.evidence / "tools.json").write_text(json.dumps(request["tools"], indent=2))
            if "<task-notification>" in latest:
                self.server.parent_notifications.append(messages[-1:])
                (self.server.evidence / "parent-notifications.json").write_text(
                    json.dumps(self.server.parent_notifications, indent=2)
                )
                if CHILD_DONE in latest:
                    self.server.notified_at = time.time()
                    self.server.consumed_at = time.time()
                    self.server.consumed_result = latest
                    role, reply = "main:consumed", ("text", DONE)
                else:
                    role, reply = "main:waiting", ("text", WAITING)
            elif "toolu_nested_agent" in text:
                self.server.agent_launch_result = background.launch_result(messages, "toolu_nested_agent")
                role, reply = "main:waiting", ("text", WAITING)
            else:
                agent = next(tool for tool in request["tools"] if tool["name"] == "Agent")
                arguments = {
                    "description": "Nested background review",
                    "prompt": CHILD_PROMPT,
                    "subagent_type": "general-purpose",
                }
                if "run_in_background" in agent["input_schema"].get("properties", {}):
                    arguments["run_in_background"] = True
                role, reply = "main:start", ("tool_use", "Agent", "toolu_nested_agent", arguments)
        elif CHILD_PROMPT in text and TASK not in text and "Bash" in names:
            if "toolu_child_read" in text:
                self.server.child_result = background.launch_result(messages, "toolu_child_read")
                role, reply = "child:consumed", ("text", CHILD_DONE)
            elif "<task-notification>" in latest:
                (self.server.evidence / "child-notification.json").write_text(json.dumps(messages[-1:], indent=2))
                output_file = re.search(r"<output-file>(.*?)</output-file>", latest).group(1)
                role, reply = "child:notification", (
                    "tool_use", "Read", "toolu_child_read", {"file_path": output_file},
                )
            elif "toolu_child_shell" in text:
                self.server.launch_result = background.launch_result(messages, "toolu_child_shell")
                role, reply = "child:waiting", ("text", WAITING)
            else:
                role, reply = "child:start", (
                    "tool_use", "Bash", "toolu_child_shell",
                    {
                        "command": self.server.review_command(),
                        "description": "Nested shell review",
                        "run_in_background": True,
                        "timeout": self.server.timeout,
                    },
                )
        else:
            role, reply = "other", ("text", "OK")
        self.emit_reply(role, reply)


def read_hooks(evidence):
    file = evidence / "hooks.jsonl"
    return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []


def instrument_hooks(root, evidence):
    """Record native hook payloads without replacing the production hooks."""
    native = shutil.which("claude")
    if native is None:
        raise RuntimeError("Run this test in the maintained Claude Code image")
    (evidence / "version.txt").write_text(subprocess.check_output([native, "--version"], text=True))
    launcher = root / "bin"
    launcher.mkdir()
    recorder = root / "record-hook.py"
    recorder.write_text(
        "import json,sys,time\n"
        "from pathlib import Path\n"
        "payload=json.load(sys.stdin)\n"
        "at=time.time()\n"
        f"with Path({str(evidence / 'hooks.jsonl')!r}).open('a') as out:\n"
        " out.write(json.dumps({'at':at,'payload':payload})+'\\n')\n"
        "if payload['hook_event_name'] in ('Stop','SubagentStop','UserPromptSubmit'):\n"
        " transcript=Path(payload.get('agent_transcript_path') or payload['transcript_path'])\n"
        " if transcript.exists():\n"
        f"  target=Path({str(evidence)!r}) / ('transcript-'+str(at)+'-'+payload['hook_event_name']+'.jsonl')\n"
        "  target.write_text(transcript.read_text())\n"
    )
    executable = launcher / "claude"
    executable.write_text(
        "#!/usr/bin/env python3\n"
        "import json,os,sys\n"
        "from pathlib import Path\n"
        "args=sys.argv[1:]\n"
        "settings=Path(args[args.index('--settings')+1])\n"
        "value=json.loads(settings.read_text())\n"
        "for event in ('Stop', 'SubagentStop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'TaskCompleted', 'StopFailure'):\n"
        " value['hooks'].setdefault(event, []).append({'matcher':'','hooks':["
        f"{{'type':'command','command':{('python3 ' + shlex.quote(str(recorder)))!r}}}"
        "]})\n"
        "settings.write_text(json.dumps(value))\n"
        f"os.execv({native!r}, [{native!r}, *args])\n"
    )
    executable.chmod(0o755)
    return launcher


class BackgroundWorkTest(unittest.TestCase):
    def test_background_review_keeps_turn_open(self):
        self.run_case("shell")

    def test_scheduled_monitor_keeps_turn_open_until_deleted(self):
        self.run_case("cron")

    def test_completed_review_is_consumed_before_completion(self):
        self.run_case("shell-fast")

    def test_stopped_background_review_can_complete(self):
        self.run_case("shell-stop")

    def test_nested_background_review_reaches_parent(self):
        self.run_case("nested")

    def test_fast_nested_review_reaches_parent_after_initial_report(self):
        self.run_case("nested-fast")

    def run_case(self, kind):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            home = root / "home"
            home.mkdir()
            evidence = Path(os.environ.get("ARCHESTRA_TEST_EVIDENCE_DIR", root)) / kind
            evidence.mkdir(parents=True, exist_ok=True)
            finished = root / "review-finished"
            prefix = runtime / "background-review"
            result = Path(str(prefix) + ".result")
            launcher = instrument_hooks(root, evidence)
            server = Upstream(evidence, finished, kind)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}"
            env = {
                **os.environ,
                "HOME": str(home),
                "TERM": "xterm-256color",
                "PATH": os.pathsep.join((str(launcher), str(BIN), os.environ["PATH"])),
                "ARCHESTRA_LLM_PROXY_PROTOCOL": "anthropic",
                "ARCHESTRA_AGENT_RUNTIME_DIR": str(runtime),
                "ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX": str(prefix),
                "ARCHESTRA_AGENT_RUNTIME_MODE": "one_shot",
                "ARCHESTRA_AGENT_RUNTIME_OPENAPPA": "1",
                "ARCHESTRA_AGENT_RUNTIME_BINDING": "synthetic-runtime-binding",
                "ARCHESTRA_AGENT_RUNTIME_NATIVE_MODEL": "claude-sonnet-4-6",
                "ARCHESTRA_AGENT_RUNTIME_TASK_ID": prefix.name,
                "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID": "background-workspace",
                "ARCHESTRA_AGENT_RUNTIME_TASK": TASK,
                "ARCHESTRA_MCP_GATEWAY_URL": origin + "/mcp",
                "ARCHESTRA_MCP_GATEWAY_TOKEN": "synthetic-token",
                "ANTHROPIC_BASE_URL": origin,
                "ANTHROPIC_AUTH_TOKEN": "synthetic-key",
                "DISABLE_AUTOUPDATER": "1",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "BASH_MAX_TIMEOUT_MS": str(server.timeout),
            }
            for name in (
                "ARCHESTRA_AGENT_RUNTIME_CONTINUE", "ARCHESTRA_AGENT_RUNTIME_CLAUDE_AUTH",
                "ARCHESTRA_AGENT_RUNTIME_PLAIN", "ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT",
                "TMUX", "TMUX_PANE",
            ):
                env.pop(name, None)
            socket = f"background-work-{root.name}"
            tmux = ["tmux", "-L", socket]
            pane_log = evidence / "pane.log"
            try:
                subprocess.run(
                    tmux + ["new-session", "-d", "-s", "agent", "-x", "180", "-y", "50",
                            "-c", str(home), str(BIN / "archestra-claude-code")],
                    env=env, check=True,
                )
                subprocess.run(tmux + ["pipe-pane", "-t", "agent", "cat >> " + str(pane_log)], env=env, check=True)
                deadline = time.monotonic() + (120 if kind == "cron" else 30 if kind == "shell-stop" else DELAY + 90)
                consumption_observed = False
                completed_at = None
                marked_at = None
                premature_marker = False
                premature_completion = False
                while time.monotonic() < deadline:
                    if (runtime / "turn-complete").exists() and marked_at is None:
                        marked_at = time.time()
                        answer_file = runtime / "final-answer.txt"
                        has_final_answer = answer_file.exists() and answer_file.read_text().strip() == server.answer
                        final_released = server.monitor_fired if kind == "cron" else server.release_final.is_set()
                        premature_marker = not (has_final_answer and final_released)
                    if result.exists() and completed_at is None:
                        completed_at = time.time()
                        premature_completion = not (
                            server.monitor_fired if kind == "cron" else consumption_observed
                        )
                    if kind != "cron" and server.consumed_at and time.time() - server.consumed_at >= 3:
                        consumption_observed = True
                        server.release_final.set()
                    # Keep observing a prematurely completed turn so the
                    # evidence also preserves the native follow-up hooks.
                    if result.exists() and any(
                        hook["payload"].get("hook_event_name") == "Stop"
                        and hook["payload"].get("last_assistant_message") == server.answer
                        for hook in read_hooks(evidence)
                    ):
                        break
                    time.sleep(0.1)
                output = pane_log.read_text(errors="replace") if pane_log.exists() else ""
                hooks = (evidence / "hooks.jsonl").read_text() if (evidence / "hooks.jsonl").exists() else ""
                state_file = runtime / "claude-background.json"
                if state_file.exists():
                    (evidence / "background-state.json").write_text(state_file.read_text())
                details = output[-3500:] + "\nLaunch result: " + server.launch_result + "\nHooks: " + hooks[-3000:]
                summary = {
                    "delay_seconds": server.delay if kind != "cron" else None,
                    "review_finished": finished.exists(),
                    "notification_received_at": server.notified_at,
                    "result_consumed_at": server.consumed_at,
                    "consumed_result": server.consumed_result,
                    "stop_result": server.stop_result,
                    "agent_launch_result": server.agent_launch_result,
                    "child_result": server.child_result,
                    "turn_completed_at": completed_at,
                    "completion_marked_at": marked_at,
                    "launch_result": server.launch_result,
                    "roles": [request["role"] for request in server.requests],
                    "monitor_fired": server.monitor_fired,
                    "held_while_consuming_result": consumption_observed,
                    "premature_completion": premature_completion,
                    "premature_marker": premature_marker,
                }
                (evidence / "summary.json").write_text(json.dumps(summary, indent=2))
                self.assertTrue(result.exists(), "No completion result was published\n" + details)
                self.assertFalse(premature_completion, "Turn completed before the background result was handled\n" + details)
                self.assertFalse(premature_marker, "Turn was marked complete before the final response\n" + details)
                stops = [hook["payload"] for hook in read_hooks(evidence) if hook["payload"].get("hook_event_name") == "Stop"]
                if kind != "cron":
                    self.assertIn("Command running in background", server.launch_result, details)
                    if kind == "shell-stop":
                        self.assertFalse(finished.exists(), "The cancelled review ran to completion\n" + details)
                        self.assertIn("Successfully stopped task", server.stop_result, details)
                    else:
                        self.assertTrue(finished.exists(), "Turn completed while the review was still running\n" + details)
                        self.assertIn("REVIEW_DONE", server.consumed_result, details)
                    self.assertTrue(consumption_observed, "Turn completed before Claude consumed the background result\n" + details)
                    if kind == "shell-fast":
                        self.assertEqual(stops[0].get("last_assistant_message"), WAITING, details)
                        self.assertFalse([
                            task for task in stops[0].get("background_tasks", [])
                            if task.get("type") == "shell"
                        ], "The shell did not finish before its first Stop\n" + details)
                    if kind.startswith("nested"):
                        self.assertIn("Async agent launched", server.agent_launch_result, details)
                        self.assertIn("REVIEW_DONE", server.child_result, details)
                        child_stops = [
                            hook["payload"] for hook in read_hooks(evidence)
                            if hook["payload"].get("hook_event_name") == "SubagentStop"
                        ]
                        self.assertGreaterEqual(len(child_stops), 2, details)
                        self.assertEqual(child_stops[0].get("last_assistant_message"), WAITING, details)
                        self.assertEqual(child_stops[-1].get("last_assistant_message"), CHILD_DONE, details)
                        self.assertTrue(all(stop.get("agent_id") for stop in child_stops), details)
                        if kind == "nested-fast":
                            self.assertFalse([
                                task for task in child_stops[0].get("background_tasks", [])
                                if task.get("type") == "shell"
                            ], "The child shell did not finish before its first Stop\n" + details)
                else:
                    self.assertTrue(server.monitor_fired, "Turn completed before the scheduled monitor fired\n" + details)
                    self.assertTrue(stops[0].get("session_crons"), "Native monitor was not registered\n" + details)
                    self.assertEqual(stops[-1].get("session_crons"), [], details)
                self.assertEqual(result.read_text().strip(), "0", details)
                self.assertEqual(Path(str(prefix) + ".log").read_text().count("===ARCHESTRA-FINAL-ANSWER==="), 1, details)
                self.assertEqual((runtime / "final-answer.txt").read_text().strip(), server.answer, details)
                self.assertFalse([report for report in server.attention if report.get("attentionState") == "input_required"], details)
                print("claude-code: completed only after the background result was handled", flush=True)
            finally:
                server.release_final.set()
                background.startup.stop_retained_client(tmux, env)
                subprocess.run(tmux + ["kill-session", "-t", "agent"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
