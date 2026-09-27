// @vitest-environment node
import type { DynamicToolUIPart } from "ai";
import { describe, expect, it } from "vitest";
import { getAskUserOutcome } from "./ask-user-outcome";

describe("getAskUserOutcome", () => {
  it("reads the structured result", () => {
    expect(
      outcomeOf({
        structuredContent: { action: "accept", selected: ["Only me", "Team"] },
      }),
    ).toEqual({ status: "answered", selected: ["Only me", "Team"] });
    expect(
      outcomeOf({ structuredContent: { action: "decline", selected: [] } }),
    ).toEqual({ status: "declined" });
    expect(
      outcomeOf({ structuredContent: { action: "cancel", selected: [] } }),
    ).toEqual({ status: "dismissed" });
    expect(
      outcomeOf({
        structuredContent: { action: "cancel", selected: [], timedOut: true },
      }),
    ).toEqual({ status: "timed-out" });
  });

  it("is waiting before the result arrives", () => {
    expect(
      getAskUserOutcome({
        part: askUserPart({ state: "input-available" }),
        toolResultPart: null,
      }),
    ).toEqual({ status: "waiting" });
  });

  it("gives up on a result it cannot read, so the generic card shows", () => {
    // Chat stores the tool's text as a string beside its structured result;
    // the text alone is guidance for the model, not a record of the answer.
    expect(
      outcomeOf({ content: "The user picked: Only me. Act on this choice." }),
    ).toBeNull();
  });

  it("treats an accepted empty selection as answered", () => {
    expect(outcomeOf({ structuredContent: { action: "accept" } })).toEqual({
      status: "answered",
      selected: [],
    });
    expect(
      outcomeOf({ structuredContent: { action: "accept", selected: [] } }),
    ).toEqual({ status: "answered", selected: [] });
  });
});

function outcomeOf(output: unknown) {
  return getAskUserOutcome({
    part: askUserPart({ state: "output-available", output }),
    toolResultPart: null,
  });
}

function askUserPart(params: {
  state: "input-available" | "output-available";
  output?: unknown;
}): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "archestra__ask_user",
    toolCallId: "call-1",
    state: params.state,
    input: {
      question: "Who should see the app?",
      options: [{ label: "Only me" }, { label: "Team" }],
    },
    output: params.output,
  } as DynamicToolUIPart;
}
