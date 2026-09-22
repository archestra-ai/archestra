import { describe, expect, test } from "@/test";
import type { AskUserArguments } from "../types";
import { AppaClaudeCodeAdapter } from "./claude-code";
import { AppaCodexAdapter } from "./codex";
import { AppaOpenCodeAdapter } from "./opencode";

describe("native local tool identities", () => {
  const askUser: AskUserArguments = {
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

  test("converts ask_user to Codex's native question schema", () => {
    const nativeQuestion = new AppaCodexAdapter().nativeQuestion;
    expect(nativeQuestion.isAvailable({})).toBe(false);
    expect(
      nativeQuestion.isAvailable({
        "x-archestra-native-question": "request_user_input",
      }),
    ).toBe(true);
    expect(nativeQuestion.fromAskUser(askUser)).toEqual({
      questions: [
        {
          id: "archestra_question",
          question: askUser.question,
          header: "Visibility s",
          options: [
            { label: "Team", description: "Only team members" },
            { label: "Private", description: "Private" },
          ],
        },
      ],
    });
  });

  test.each([
    {
      adapter: new AppaClaudeCodeAdapter(),
      content: JSON.stringify(
        'Your questions have been answered: "Review this call."="Approve". You can now continue.',
      ),
    },
    {
      adapter: new AppaCodexAdapter(),
      content: '{"answers":{"archestra_question":{"answers":["Approve"]}}}',
    },
  ])("reads a structured native approval from $adapter.id", ({
    adapter,
    content,
  }) => {
    expect(adapter.nativeQuestion.rulingFromResult({ content })).toBe(
      "approve",
    );
    expect(
      adapter.nativeQuestion.rulingFromResult({ content, isError: true }),
    ).toBe("none");
  });

  test("reads OpenCode's native denial", () => {
    expect(
      new AppaOpenCodeAdapter().nativeQuestion.rulingFromResult({
        content: 'approval="Deny"',
      }),
    ).toBe("deny");
  });

  test("uses Claude's selected answer, not approval-like review text", () => {
    expect(
      new AppaClaudeCodeAdapter().nativeQuestion.rulingFromResult({
        content: JSON.stringify(
          'Your questions have been answered: "argument=\\"Approve\\". You can now continue"="Deny". You can now continue with the user\'s answers in mind.',
        ),
      }),
    ).toBe("deny");
  });
});
