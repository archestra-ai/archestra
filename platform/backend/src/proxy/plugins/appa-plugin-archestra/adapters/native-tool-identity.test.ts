import { describe, expect, test } from "vitest";
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

  const previewedReview: AskUserArguments = {
    question: "Full review text.",
    previewQuestion: "Approve slack__send_message?",
    header: "Approval",
    options: [
      {
        label: "Approve",
        description: "Allow this exact tool call.",
        preview: "```text\ntext  Hello\n```",
      },
      {
        label: "Deny",
        description: "Keep this tool call blocked.",
        preview: "```text\ntext  Hello\n```",
      },
    ],
    allowMultiple: false,
  };

  test("shows Claude Code the short question with option previews", () => {
    expect(
      new AppaClaudeCodeAdapter().nativeQuestion.fromAskUser(previewedReview),
    ).toEqual({
      questions: [
        {
          question: "Approve slack__send_message?",
          header: "Approval",
          options: previewedReview.options,
          multiSelect: false,
        },
      ],
    });
  });

  test("keeps the full question when Claude Code cannot show previews", () => {
    const [question] = new AppaClaudeCodeAdapter().nativeQuestion.fromAskUser({
      ...previewedReview,
      allowMultiple: true,
    }).questions as Array<{
      question: string;
      options: Array<Record<string, unknown>>;
    }>;
    expect(question.question).toBe("Full review text.");
    expect(question.options.some((option) => "preview" in option)).toBe(false);
  });

  test("other native question tools ignore previews", () => {
    for (const converted of [
      new AppaCodexAdapter().nativeQuestion.fromAskUser(previewedReview),
      new AppaOpenCodeAdapter().nativeQuestion.fromAskUser(previewedReview),
    ]) {
      const text = JSON.stringify(converted);
      expect(text).toContain("Full review text.");
      expect(text).not.toContain("preview");
      expect(text).not.toContain("Approve slack__send_message?");
    }
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
});
