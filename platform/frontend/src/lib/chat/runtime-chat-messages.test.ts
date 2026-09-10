import { expect, test } from "vitest";
import { runtimeChatMessages } from "./runtime-chat-messages";

test("pairs parallel tool results by ID without moving text across user turns", () => {
  const messages = runtimeChatMessages({
    version: 1,
    provider: "custom",
    entries: [
      { type: "message", role: "user", text: "Inspect files", id: "u1" },
      {
        type: "tool_call",
        name: "read",
        input: '{"path":"a"}',
        toolCallId: "a",
      },
      {
        type: "tool_call",
        name: "read",
        input: '{"path":"b"}',
        toolCallId: "b",
      },
      {
        type: "tool_result",
        toolCallId: "b",
        text: "File missing",
        isError: true,
      },
      { type: "tool_result", toolCallId: "a", text: "CEDAR" },
      { type: "message", role: "assistant", text: "One file exists" },
      { type: "message", role: "user", text: "Continue", id: "u2" },
      { type: "message", role: "assistant", text: "Next turn" },
    ],
  });
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(messages[1].parts).toEqual([
    {
      type: "dynamic-tool",
      toolName: "read",
      toolCallId: "a",
      input: { path: "a" },
      state: "output-available",
      output: "CEDAR",
    },
    {
      type: "dynamic-tool",
      toolName: "read",
      toolCallId: "b",
      input: { path: "b" },
      state: "output-error",
      errorText: "File missing",
    },
    { type: "text", text: "One file exists" },
  ]);
});
