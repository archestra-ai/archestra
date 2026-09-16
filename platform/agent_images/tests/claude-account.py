"""Exercise the disposable Herdr setup-token boundary without credentials."""

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


loader = importlib.machinery.SourceFileLoader(
    "claude_account",
    str(Path(__file__).resolve().parents[1] / "bin/archestra-claude-account"),
)
# Container image tests mount only this directory; use the installed helper there.
if not Path(loader.path).exists():
    loader = importlib.machinery.SourceFileLoader(
        "claude_account", "/usr/local/bin/archestra-claude-account"
    )
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)
TOKEN = "sk-ant-oat01-" + "example" * 8


class FakeClock:
    def __init__(self, start=0):
        self.now = start

    def monotonic(self):
        return self.now


class FakeSelector:
    def __init__(self, clock, ready_at=None, advance=None):
        self.clock = clock
        self.ready_at = ready_at
        self.advance = advance
        self.waits = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def register(self, *_):
        pass

    def select(self, timeout):
        self.waits.append(timeout)
        self.clock.now += self.advance if self.advance is not None else timeout
        return [object()] if self.ready_at is not None and self.clock.now >= self.ready_at else []


class FakeStream:
    def __init__(self, fileno):
        self._fileno = fileno
        self.writes = []

    def fileno(self):
        return self._fileno

    def write(self, data):
        self.writes.append(data)
        return len(data)

    def flush(self):
        pass


class FakeProcess:
    def __init__(self, clock, wait_times_out=False):
        self.clock = clock
        self.stdin = FakeStream(101)
        self.stdout = FakeStream(102)
        self.args = ["claude"]
        self.wait_times_out = wait_times_out
        self.terminated = False
        self.killed = False
        self.wait_calls = []

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        self.wait_calls.append(timeout)
        if timeout is not None and self.wait_times_out:
            self.clock.now += timeout
            raise subprocess.TimeoutExpired(self.args, timeout)


class AccountTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        helper.directory = root
        helper.submitted = root / "submitted"
        helper.started = root / "started"
        helper.exit_file = root / "exit-status"
        helper.state_file = root / "herdr-state.json"
        helper.raw_log = root / "terminal.raw"
        helper.config_file = root / "herdr-config.toml"
        helper.socket_file = root / "herdr.sock"
        helper.client_socket_file = root / "herdr-client.sock"
        helper.flow_id = "test-flow"
        self.calls = []
        self.api = patch.object(helper, "api_request", side_effect=self.api_request)
        self.api.start()
        self.addCleanup(self.api.stop)

    def api_request(self, method, params, request_id):
        self.calls.append((method, params, request_id))
        if method == "ping":
            return {}
        if method == "workspace.create":
            return {
                "workspace": {"workspace_id": "workspace-1"},
                "tab": {"tab_id": "tab-1"},
                "root_pane": {"pane_id": "pane-shell"},
            }
        if method == "layout.apply":
            return {"layout": {"root": {"type": "pane", "pane_id": "pane-1"}}}
        if method == "pane.get":
            return {"pane": {"terminal_id": "term-1"}}
        return {}

    def prepare_live_flow(self):
        helper.ensure_directories()
        helper.started.touch(mode=0o600)
        helper.write_state(
            {
                "flowId": helper.flow_id,
                "workspaceId": "workspace-1",
                "tabId": "tab-1",
                "paneId": "pane-1",
                "terminalId": "term-1",
            }
        )

    def invoke(self, operation, body=None):
        argv = patch("sys.argv", ["helper", operation])
        stdin = patch("sys.stdin", io.StringIO(json.dumps(body or {})))
        with argv, stdin, contextlib.redirect_stdout(io.StringIO()) as output:
            helper.main()
        return json.loads(output.getvalue())

    def test_start_uses_one_private_herdr_pane_and_fixed_dimensions(self):
        with patch.object(helper, "ensure_server") as start_server:
            result = helper.start_login()
        start_server.assert_called_once_with()
        self.assertEqual(result["state"], "starting")
        config = helper.config_file.read_text()
        self.assertIn("headless_cols = 500", config)
        self.assertIn("headless_rows = 40", config)
        self.assertIn("resume_agents_on_restore = false", config)
        methods = [method for method, _, _ in self.calls]
        self.assertEqual(
            methods,
            ["workspace.create", "layout.apply", "tab.close", "pane.get", "pane.get"],
        )
        layout = next(params for method, params, _ in self.calls if method == "layout.apply")
        command = layout["root"]["command"]
        self.assertEqual(command[:2], ["/usr/bin/env", "-i"])
        self.assertIn("claude", command[-1])
        self.assertIn("setup-token", command[-1])
        self.assertNotIn("tmux", json.dumps(command))

    def test_authorization_url_and_token_are_read_from_complete_raw_capture(self):
        self.prepare_live_flow()
        long_url = (
            "https://claude.com/cai/oauth/authorize?state="
            + "a" * 520
            + "&code_challenge="
            + "b" * 520
        )
        wrapped = "\n".join(
            long_url[index : index + 500] for index in range(0, len(long_url), 500)
        )
        helper.raw_log.write_text("old output\n" + wrapped + "\n", encoding="utf-8")
        result = helper.status()
        self.assertEqual(result["state"], "awaiting_code")
        self.assertEqual(result["authorizationUrl"], long_url)

        helper.raw_log.write_text(
            "\n".join(f"noise-{index}" for index in range(1101))
            + "\n"
            + TOKEN,
            encoding="utf-8",
        )
        self.assertEqual(helper.captured_token(), TOKEN)
        self.assertEqual(helper.status(), {"state": "connecting", "flowId": "test-flow"})

    def test_authorization_code_is_submitted_once_over_the_socket_and_bound_to_flow(self):
        self.prepare_live_flow()
        code = "one-time-code"
        first = self.invoke("complete", {"flowId": "test-flow", "code": code})
        second = self.invoke("complete", {"flowId": "test-flow", "code": code})
        sends = [entry for entry in self.calls if entry[0] in {"pane.send_text", "pane.send_keys"}]
        self.assertEqual(first, {"state": "connecting"})
        self.assertEqual(second, {"state": "connecting"})
        self.assertEqual([entry[0] for entry in sends], ["pane.send_text", "pane.send_keys"])
        self.assertEqual(sends[0][1]["text"], code)
        self.assertEqual(sends[1][1]["keys"], ["Enter"])
        self.assertTrue(helper.submitted.exists())
        self.assertNotIn(code, json.dumps([entry[2] for entry in sends]))
        with self.assertRaisesRegex(ValueError, "expired"):
            self.invoke("complete", {"flowId": "different-flow", "code": "ignored"})

    def test_cleanup_closes_workspace_and_removes_private_capture(self):
        self.prepare_live_flow()
        helper.raw_log.write_text(TOKEN, encoding="utf-8")
        helper.submitted.touch(mode=0o600)
        result = self.invoke("cleanup")
        self.assertEqual(result, {"state": "failed"})
        methods = [method for method, _, _ in self.calls]
        self.assertIn("workspace.close", methods)
        self.assertIn("server.stop", methods)
        self.assertFalse(helper.raw_log.exists())
        self.assertFalse(helper.submitted.exists())

    def test_models_accepts_metadata_after_original_deadline_before_new_deadline(self):
        clock = FakeClock()
        process = FakeProcess(clock)
        response = json.dumps(
            {
                "type": "control_response",
                "response": {
                    "request_id": "runtime-models",
                    "response": {
                        "models": [
                            {
                                "value": "sonnet",
                                "displayName": "Sonnet",
                                "description": "Test model",
                            }
                        ]
                    },
                },
            }
        ).encode() + b"\n"

        def read(fd, _):
            self.assertEqual(fd, process.stdout.fileno())
            return response

        with patch.object(helper.subprocess, "Popen", return_value=process), \
                patch.object(helper.selectors, "DefaultSelector", lambda: FakeSelector(clock, 21)), \
                patch.object(helper.os, "read", side_effect=read), \
                patch.object(helper.time, "monotonic", side_effect=clock.monotonic):
            result = helper.supported_models(TOKEN)

        self.assertEqual(result, [{
            "value": "sonnet",
            "displayName": "Sonnet",
            "description": "Test model",
        }])
        self.assertEqual(clock.now, 21)
        self.assertTrue(process.terminated)
        self.assertFalse(process.killed)
        self.assertEqual(process.wait_calls, [5])

    def test_models_timeout_forces_bounded_cleanup_within_exec_budget(self):
        clock = FakeClock(start=0.25)
        started = clock.now
        process = FakeProcess(clock, wait_times_out=True)
        selector = FakeSelector(clock, advance=0.75)

        with patch.object(helper.subprocess, "Popen", return_value=process), \
                patch.object(helper.selectors, "DefaultSelector", lambda: selector), \
                patch.object(helper.time, "monotonic", side_effect=clock.monotonic):
            with self.assertRaisesRegex(ValueError, "did not return its available models"):
                helper.supported_models(TOKEN)

        elapsed = clock.now - started
        self.assertAlmostEqual(elapsed, helper.MODEL_METADATA_TIMEOUT + 5)
        self.assertLess(elapsed, 30)
        self.assertLess(selector.waits[-1], 1)
        self.assertLessEqual(max(selector.waits), 1)
        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertEqual(process.wait_calls, [5, None])


if __name__ == "__main__":
    unittest.main()
