import { describe, expect, test } from "@/test";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";

describe("APPA client adapters", () => {
  test("identifies native client metadata and classifies local tools", () => {
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
      new AppaClaudeCodeAdapter().normalizeLocalToolName(
        "host/claude-code/Bash",
      ),
    ).toBe("host/claude-code/Bash");
    expect(
      new AppaCodexAdapter().normalizeLocalToolName("functions.exec_command"),
    ).toBe("builtin:exec_command");
    expect(new AppaOpenCodeAdapter().normalizeLocalToolName("read_file")).toBe(
      "builtin:read_file",
    );
    expect(
      new AppaClaudeCodeAdapter().getNativeSessionId({
        headers: { "x-claude-code-session-id": "claude-session" },
        requestBody: {},
      }),
    ).toBe("claude-session");
    expect(
      new AppaCodexAdapter().getNativeSessionId({
        headers: { "x-codex-turn-metadata": "codex-turn" },
        requestBody: {},
      }),
    ).toBe("codex-turn");
    expect(new AppaOpenCodeAdapter().classifyToolName("mcp:gateway:read")).toBe(
      "gateway",
    );
    expect(
      new AppaClaudeCodeAdapter().classifyToolName("mcp__gateway__read"),
    ).toBe("gateway");
    expect(new AppaClaudeCodeAdapter().classifyToolName("Bash")).toBe("local");
  });
});
