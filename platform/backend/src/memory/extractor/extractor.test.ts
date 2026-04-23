import { describe, expect, test } from "vitest";
import { __test, hasExternalContextBoundary } from "./extractor";

describe("hasExternalContextBoundary", () => {
  test("returns true when unsafe boundary exists in tool output metadata", () => {
    const hasBoundary = hasExternalContextBoundary([
      {
        role: "assistant",
        parts: [
          {
            type: "tool-result",
            output: {
              _meta: {
                unsafeContextBoundary: {
                  kind: "tool_result",
                  reason: "tool_result_marked_untrusted",
                  toolCallId: "call-1",
                  toolName: "search",
                },
              },
            },
          },
        ],
      },
    ]);

    expect(hasBoundary).toBe(true);
  });

  test("returns false when no unsafe boundary exists", () => {
    const hasBoundary = hasExternalContextBoundary([
      {
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "world" }],
      },
    ]);

    expect(hasBoundary).toBe(false);
  });
});

describe("buildTranscript", () => {
  test("keeps only user and assistant text parts", () => {
    const transcript = __test.buildTranscript([
      {
        role: "system",
        parts: [{ type: "text", text: "system" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "user text" }],
      },
      {
        role: "assistant",
        parts: [
          { type: "tool-call", toolCallId: "call-1", toolName: "search" },
          { type: "text", text: "assistant text" },
        ],
      },
    ]);

    expect(transcript).toContain("user: user text");
    expect(transcript).toContain("assistant: assistant text");
    expect(transcript).not.toContain("system");
  });

  test("clamps transcript to 20k characters", () => {
    const longText = "x".repeat(22_000);
    const transcript = __test.buildTranscript([
      {
        role: "user",
        parts: [{ type: "text", text: longText }],
      },
    ]);

    expect(transcript.length).toBe(20_000);
    expect(transcript.endsWith("x".repeat(50))).toBe(true);
  });
});

describe("collectSourceMessageIds", () => {
  test("returns only uuid ids for user/assistant messages", () => {
    const ids = __test.collectSourceMessageIds([
      {
        id: "4c79b8fa-f61a-42b1-b6c5-6f0be5425b43",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      {
        id: "not-a-uuid",
        role: "assistant",
        parts: [{ type: "text", text: "world" }],
      },
      {
        id: "9d2e6d09-a6a8-4f22-948d-54835de39753",
        role: "tool",
        parts: [{ type: "text", text: "ignored" }],
      },
    ]);

    expect(ids).toEqual(["4c79b8fa-f61a-42b1-b6c5-6f0be5425b43"]);
  });
});
