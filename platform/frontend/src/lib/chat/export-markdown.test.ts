import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, test } from "vitest";
import { messagesToMarkdown } from "./export-markdown";

const exportedAt = new Date("2026-05-28T10:00:00.000Z");

describe("messagesToMarkdown", () => {
  test("renders header + role sections + text parts", () => {
    const messages = [
      makeMessage("user", [{ type: "text", text: "hello" }]),
      makeMessage("assistant", [{ type: "text", text: "world" }]),
    ];

    const md = messagesToMarkdown({
      messages,
      conversationId: "1bb587ad-9c76-48bb-97b3-448e5c87223b",
      title: "Slack gif debug",
      agentName: "n8n expert",
      exportedAt,
    });

    expect(md).toContain("# Slack gif debug");
    expect(md).toContain("- Agent: n8n expert");
    expect(md).toContain("## user");
    expect(md).toContain("hello");
    expect(md).toContain("## assistant");
    expect(md).toContain("world");
  });

  test("renders tool parts (tool-<name> and dynamic-tool) with input/output/error", () => {
    const messages = [
      makeMessage("assistant", [
        {
          type: "tool-run_command",
          state: "output-available",
          toolCallId: "call-1",
          input: { command: "ls" },
          output: { stdout: "SKILL.md\n" },
        },
        {
          type: "dynamic-tool",
          toolName: "download_file",
          state: "output-error",
          input: { path: "out.bin" },
          errorText: "permission denied",
        },
      ]),
    ];

    const md = messagesToMarkdown({
      messages,
      conversationId: "c1",
      exportedAt,
    });

    expect(md).toContain("### Tool: `run_command`");
    expect(md).toContain("state=`output-available`");
    expect(md).toContain('"command": "ls"');
    expect(md).toContain('"stdout": "SKILL.md\\n"');
    expect(md).toContain("### Tool: `download_file`");
    expect(md).toContain("**Error:**");
    expect(md).toContain("permission denied");
  });

  test("falls back to conversation id when title is missing", () => {
    const md = messagesToMarkdown({
      messages: [],
      conversationId: "abc",
      exportedAt,
    });
    expect(md).toMatch(/^# Chat abc/);
    expect(md).toContain("- Messages: 0");
  });
});

function makeMessage(
  role: UIMessage["role"],
  parts: ReadonlyArray<Record<string, unknown>>,
): UIMessage {
  return {
    id: `m-${role}-${parts.length}`,
    role,
    parts: parts as UIMessage["parts"],
  } as UIMessage;
}
