import type { UIMessage } from "ai";
import { describe, expect, test } from "vitest";
import { extractProtocolPartsFromUIMessage } from "./a2a-response-parts";

describe("A2A final response parts", () => {
  test("excludes tool-retry commentary while retaining the complete transcript", () => {
    const message: UIMessage = {
      id: "response",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "text",
          text: "I used the wrong arguments. Retrying the tool.",
        },
        {
          type: "dynamic-tool",
          toolName: "start_run",
          toolCallId: "call",
          state: "output-available",
          input: {},
          output: { success: true },
        },
        { type: "step-start" },
        { type: "reasoning", text: "execution notes" },
        { type: "text", text: "Run started. " },
        { type: "text", text: "Reply in this thread to continue." },
      ],
    };
    expect(extractProtocolPartsFromUIMessage(message)).toEqual([
      { text: "Run started. " },
      { text: "Reply in this thread to continue." },
    ]);
    expect(message.parts).toHaveLength(7);
  });

  test("does not reuse earlier commentary when the last step has no answer", () => {
    expect(
      extractProtocolPartsFromUIMessage({
        id: "response",
        role: "assistant",
        parts: [
          { type: "text", text: "I will investigate." },
          { type: "step-start" },
        ],
      }),
    ).toEqual([]);
  });

  test("keeps text from legacy responses without step boundaries", () => {
    expect(
      extractProtocolPartsFromUIMessage({
        id: "response",
        role: "assistant",
        parts: [{ type: "text", text: "Research complete." }],
      }),
    ).toEqual([{ text: "Research complete." }]);
  });
});
