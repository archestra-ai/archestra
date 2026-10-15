"""Check the Claude MCP status formats before the real-client startup tests."""

import os
from pathlib import Path
import runpy
import unittest


BIN = Path(os.environ.get("ARCHESTRA_TEST_WRAPPERS", "/usr/local/bin"))
gateway_state = runpy.run_path(str(BIN / "archestra-claude-tui-start"))["gateway_state"]


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


if __name__ == "__main__":
    unittest.main()
