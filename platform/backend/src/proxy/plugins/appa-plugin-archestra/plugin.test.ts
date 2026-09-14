import { describe, expect, test } from "@/test";
import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";

describe("APPA client adapters", () => {
  test("maps each integrated client to its real local tool namespace", () => {
    const chat = new AppaChatAdapter();
    const claudeCode = new AppaClaudeCodeAdapter();
    const codex = new AppaCodexAdapter();
    const openCode = new AppaOpenCodeAdapter();

    expect(
      chat.matches({
        headers: {},
        requestBody: {},
        trustedContext: {
          session: {
            organization_id: "org",
            caller_id: "user:user",
            session_id: "conversation",
          },
          profileId: "profile",
          canonicalizeToolName: (name) => name,
          chatSource: "chat:tool_call_repair",
        },
      }),
    ).toBe(true);
    expect(chat.classifyToolName("archestra__run_command")).toBe("gateway");
    expect(chat.normalizeLocalToolName("read_file")).toBe("read_file");

    expect(
      claudeCode.matches({
        headers: { "User-Agent": "Claude-Code/1" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(
      codex.matches({
        headers: { originator: "codex" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(
      openCode.matches({
        headers: { "x-opencode-session": "s" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(claudeCode.normalizeLocalToolName("host/claude-code/Bash")).toBe(
      "host/claude-code/Bash",
    );
    expect(codex.normalizeLocalToolName("functions.exec_command")).toBe(
      "builtin:exec_command",
    );
    expect(openCode.normalizeLocalToolName("read_file")).toBe(
      "builtin:read_file",
    );
    expect(openCode.classifyToolName("mcp:gateway:read")).toBe("gateway");
    expect(claudeCode.classifyToolName("mcp__gateway__read")).toBe("gateway");
    expect(claudeCode.classifyToolName("Bash")).toBe("local");
  });
});
