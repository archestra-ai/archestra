import type { UIMessage } from "ai";
import { describe, expect, test } from "vitest";
import { hasUnavailableScheduleReview } from "./schedule-review-outcome";

const getToolShortName = (name: string) =>
  name.startsWith("archestra__") ? name.slice("archestra__".length) : null;
const unavailable = {
  ok: false,
  outcome: "review_unavailable",
  offer_id: "review-1",
};

function message(
  output: unknown,
  toolName = "archestra__execute_remedy_plan",
): UIMessage {
  return {
    id: "message-1",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName,
        toolCallId: "call-1",
        state: "output-available",
        input: { offer_id: "review-1", plan: "Submit for approval" },
        output,
      },
    ],
  };
}

describe("hasUnavailableScheduleReview", () => {
  test.each([
    unavailable,
    JSON.stringify(unavailable),
    { content: JSON.stringify(unavailable), _meta: {} },
  ])("recognizes a closed platform review in supported tool output shapes", (output) => {
    expect(
      hasUnavailableScheduleReview(message(output), getToolShortName),
    ).toBe(true);
  });

  test("recognizes static tools and the run_tool dispatch used in auto mode", () => {
    const staticMessage: UIMessage = {
      id: "static",
      role: "assistant",
      parts: [
        {
          type: "tool-archestra__execute_remedy_plan",
          toolCallId: "call-1",
          state: "output-available",
          input: { offer_id: "review-1" },
          output: { content: JSON.stringify(unavailable) },
        },
      ],
    };
    expect(hasUnavailableScheduleReview(staticMessage, getToolShortName)).toBe(
      true,
    );
    const dispatched = message(
      JSON.stringify(unavailable),
      "archestra__run_tool",
    );
    const part = dispatched.parts[0];
    if (part.type !== "dynamic-tool") throw new Error("Expected dynamic tool");
    part.input = {
      tool_name: "archestra__execute_remedy_plan",
      tool_args: { offer_id: "review-1" },
    };
    expect(hasUnavailableScheduleReview(dispatched, getToolShortName)).toBe(
      true,
    );
  });

  test.each([
    "[appa] Blocked: a call cannot run yet",
    "[appa] Authorized. Retry the original call.",
    { ok: false, outcome: "review_required", offer_id: "review-1" },
    { ...unavailable, ok: true },
    { ...unavailable, offer_id: "different-review" },
    null,
  ])("does not turn recoverable notices or unrelated results into failed runs", (output) => {
    expect(
      hasUnavailableScheduleReview(message(output), getToolShortName),
    ).toBe(false);
  });

  test("ignores the same text in assistant prose or another server's output", () => {
    expect(
      hasUnavailableScheduleReview(
        message(unavailable, "external__execute_remedy_plan"),
        getToolShortName,
      ),
    ).toBe(false);
    expect(
      hasUnavailableScheduleReview(
        {
          id: "text",
          role: "assistant",
          parts: [{ type: "text", text: JSON.stringify(unavailable) }],
        },
        getToolShortName,
      ),
    ).toBe(false);
  });
});
