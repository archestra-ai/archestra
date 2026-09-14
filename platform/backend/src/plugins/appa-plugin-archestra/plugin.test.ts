import { describe, expect, test } from "@/test";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";

describe("APPA client adapters", () => {
  test("identifies supported clients and preserves canonical tool names", () => {
    expect(
      new AppaClaudeCodeAdapter().matches({
        headers: { "user-agent": "Claude-Code/1" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(
      new AppaCodexAdapter().matches({
        headers: { originator: "codex" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(
      new AppaOpenCodeAdapter().matches({
        headers: { "x-opencode-session": "s" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(
      new AppaClaudeCodeAdapter().normalizeLocalToolName("mcp__gateway__read"),
    ).toBe("mcp__gateway__read");
    expect(
      new AppaCodexAdapter().normalizeLocalToolName("functions.exec_command"),
    ).toBe("builtin:exec_command");
    expect(new AppaOpenCodeAdapter().normalizeLocalToolName("read_file")).toBe(
      "builtin:read_file",
    );
  });
});
