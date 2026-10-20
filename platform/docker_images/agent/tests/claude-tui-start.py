"""Check Claude status formats before the real-client startup tests."""

import io
import os
from pathlib import Path
import runpy
import unittest
from unittest.mock import Mock, patch


BIN = Path(os.environ.get("ARCHESTRA_TEST_WRAPPERS", "/usr/local/bin"))
wrapper = runpy.run_path(str(BIN / "archestra-claude-tui-start"))
gateway_state = wrapper["gateway_state"]
paste_in_progress = wrapper["paste_in_progress"]


class GatewayStateTest(unittest.TestCase):
    def test_ready_requires_connection_and_positive_tool_count(self):
        for row in (
            "archestra connected 3 tools",
            "archestra connected 1 tool",
            "archestra connected 12 tools",
            "\u276f \u2714 archestra 3 tools",
            "\u2714 archestra 1 tool",
            "\u2714 archestra 12 tools",
        ):
            with self.subTest(row=row):
                self.assertEqual(gateway_state(row), "ready")

    def test_failed_connection_wins_over_cached_tools(self):
        for row in (
            "archestra failed",
            "archestra FAILED 3 tools",
            "\u276f \u2718 archestra",
            "\u2718 archestra 3 tools",
            "\u2718 archestra connected 3 tools",
            "\u2714 archestra failed 3 tools",
        ):
            with self.subTest(row=row):
                self.assertEqual(gateway_state(row), "failed")

    def test_unknown_empty_or_unrelated_status_never_submits(self):
        for row in (
            "",
            "archestra connected 0 tools",
            "\u2714 archestra 0 tools",
            "archestra connecting 3 tools",
            "archestra disconnected 3 tools",
            "archestra 3 tools",
            "archestra connected",
            "\u2714 archestra",
            "\u2714 other-server 3 tools",
            "\u2714 archestra-other 3 tools",
            "\u2714 my-archestra 3 tools",
            "Built-in MCPs (always available)",
        ):
            with self.subTest(row=row):
                self.assertEqual(gateway_state(row), "pending")

    def test_menu_uses_only_the_exact_gateway_row(self):
        self.assertEqual(gateway_state(
            "\u2714 archestra-other 9 tools\n\u276f \u2718 archestra\n"
            "https://code.claude.com/docs/en/mcp for help"
        ), "failed")
        self.assertEqual(gateway_state(
            "\u2718 other-server\nBuilt-in MCPs (always available)\n"
            "\u276f \u2714 archestra 3 tools"
        ), "ready")


class PasteStateTest(unittest.TestCase):
    def test_waits_for_paste_status_below_input(self):
        for status in ("Pasting…", "Pasting..."):
            with self.subTest(status=status):
                self.assertTrue(paste_in_progress("───\n❯ task\n───\n  " + status + "\n"))

    def test_ignores_pasting_text_in_prompt_or_history(self):
        self.assertFalse(paste_in_progress("Pasting…\n───\n❯ Explain:\nPasting...\n───\n  ⏵⏵ bypass permissions on\n"))

    def test_ready_footer_is_not_pasting(self):
        self.assertFalse(paste_in_progress("───\n❯ [Image #1] task\n───\n  ⏵⏵ bypass permissions on\n"))

    def test_stuck_paste_fails_without_sending_enter(self):
        prompt = "───\n❯ task\n───\n  ⏵⏵ bypass permissions on\n"
        screens = iter((prompt, "Manage MCP servers\n✔ archestra 3 tools", prompt))
        child = Mock()
        child.poll.return_value = None
        child.wait.return_value = 0
        elapsed = 0.0

        def sleep(seconds):
            nonlocal elapsed
            elapsed += seconds

        with (
            patch.dict(os.environ, {"TMUX_PANE": "%1", "ARCHESTRA_AGENT_RUNTIME_TASK": "task"}, clear=True),
            patch("subprocess.Popen", return_value=child),
            patch("subprocess.check_output", side_effect=lambda *args, **kwargs: next(screens, "───\n❯ task\n───\n  Pasting…\n")),
            patch("subprocess.run") as run,
            patch("time.monotonic", side_effect=lambda: elapsed),
            patch("time.sleep", side_effect=sleep),
            patch("signal.signal"),
            patch("sys.stderr", new_callable=io.StringIO),
        ):
            self.assertNotEqual(wrapper["main"](), 0)

        commands = [call.args[0] for call in run.call_args_list]
        pasted = next(index for index, command in enumerate(commands) if "\x1b[200~task\x1b[201~" in command)
        self.assertFalse(any(command[-1] == "Enter" for command in commands[pasted + 1:]))
        failures = [command for command in commands if Path(command[0]).name == "archestra-agent-failure"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0][1], "claude_prompt_submission")
        child.terminate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
