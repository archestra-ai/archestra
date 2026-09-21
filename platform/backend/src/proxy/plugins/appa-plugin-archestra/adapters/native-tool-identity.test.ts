import { describe, expect, test } from "@/test";
import { AppaClaudeCodeAdapter } from "./claude-code";
import { AppaCodexAdapter } from "./codex";
import { AppaOpenCodeAdapter } from "./opencode";

describe("native local tool identities", () => {
  const askUser = {
    question: "Who can see this app?",
    header: "Visibility settings",
    options: [
      { label: "Team", description: "Only team members" },
      { label: "Private" },
    ],
    allowMultiple: true,
  };

  test.each([
    {
      adapter: new AppaCodexAdapter(),
      clientName: "functions.builtin:exec_command",
      runtimeName: "exec_command",
    },
    {
      adapter: new AppaOpenCodeAdapter(),
      clientName: "builtin:read_file",
      runtimeName: "read_file",
    },
    {
      adapter: new AppaClaudeCodeAdapter(),
      clientName: "Bash",
      runtimeName: "Bash",
    },
    // A persisted result can carry this decoration from the prior adapter.
    {
      adapter: new AppaClaudeCodeAdapter(),
      clientName: "host/claude-code/AskUserQuestion",
      runtimeName: "AskUserQuestion",
    },
  ])("normalizes $clientName to the runtime spelling", ({
    adapter,
    clientName,
    runtimeName,
  }) => {
    expect(adapter.classifyToolName(clientName)).toBe("local");
    expect(adapter.normalizeLocalToolName(clientName)).toBe(runtimeName);
  });

  test.each([
    {
      adapter: new AppaCodexAdapter(),
      name: "mcp:gateway:exec_command",
    },
    {
      adapter: new AppaOpenCodeAdapter(),
      name: "mcp:gateway:read_file",
    },
    {
      adapter: new AppaClaudeCodeAdapter(),
      name: "mcp__gateway__Bash",
    },
  ])("keeps $name in its MCP gateway namespace", ({ adapter, name }) => {
    expect(adapter.classifyToolName(name)).toBe("gateway");
  });

  test("converts ask_user to Claude Code's native question schema", () => {
    expect(
      new AppaClaudeCodeAdapter().nativeQuestion.fromAskUser(askUser),
    ).toEqual({
      questions: [
        {
          question: askUser.question,
          header: "Visibility s",
          options: [
            { label: "Team", description: "Only team members" },
            { label: "Private", description: "Private" },
          ],
          multiSelect: true,
        },
      ],
    });
  });

  test("does not rewrite ask_user through Codex's gated question tool", () => {
    expect(new AppaCodexAdapter().nativeQuestion).toEqual({
      toolName: "request_user_input",
    });
  });
});
