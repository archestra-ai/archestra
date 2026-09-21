import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { identifyAskUserGroups } from "./ask-user-groups";

describe("identifyAskUserGroups", () => {
  it("keeps parallel calls in one step and pairs separated results by toolCallId", () => {
    const groups = identifyAskUserGroups({
      messageId: "assistant-1",
      parts: [
        { type: "step-start" },
        askUserInput("call-color", "Pick a color"),
        otherTool("call-search"),
        askUserInput("call-fruit", "Pick a fruit"),
        askUserResult("call-fruit", "Apple"),
        askUserResult("call-color", "Blue"),
      ] as UIMessage["parts"],
      getToolShortName,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "assistant-1-ask-user-1",
      firstIndex: 1,
      members: [
        { toolCallId: "call-color", question: "Pick a color" },
        { toolCallId: "call-fruit", question: "Pick a fruit" },
      ],
    });
    expect(groups[0].members.map((member) => member.outcome)).toEqual([
      { status: "answered", selected: ["Blue"] },
      { status: "answered", selected: ["Apple"] },
    ]);
    expect([...groups[0].consumedIndices].sort()).toEqual([1, 3, 4, 5]);
  });

  it("keeps later step-start batches separate", () => {
    const groups = identifyAskUserGroups({
      messageId: "assistant-1",
      parts: [
        { type: "step-start" },
        askUserInput("call-first", "First?"),
        { type: "step-start" },
        askUserInput("call-second", "Second?"),
      ] as UIMessage["parts"],
      getToolShortName,
    });

    expect(groups.map((group) => group.key)).toEqual([
      "assistant-1-ask-user-1",
      "assistant-1-ask-user-2",
    ]);
  });

  it("does not merge sequential result phases without step markers", () => {
    const groups = identifyAskUserGroups({
      messageId: "assistant-1",
      parts: [
        askUserInput("call-first", "First?"),
        askUserResult("call-first", "A"),
        askUserInput("call-second", "Second?"),
        askUserResult("call-second", "B"),
      ] as UIMessage["parts"],
      getToolShortName,
    });

    expect(groups.map((group) => group.members[0].toolCallId)).toEqual([
      "call-first",
      "call-second",
    ]);
  });

  it("leaves ask_user errors for the existing generic tool error UI", () => {
    const groups = identifyAskUserGroups({
      messageId: "assistant-1",
      parts: [
        {
          ...askUserInput("call-failed", "Will this fail?"),
          state: "output-error",
          errorText: "Request failed",
        },
      ] as UIMessage["parts"],
      getToolShortName,
    });

    expect(groups).toEqual([]);
  });

  it("does not consume an unreadable output that lacks an ask_user outcome", () => {
    const groups = identifyAskUserGroups({
      messageId: "assistant-1",
      parts: [
        askUserInput("call-plain", "Will this render raw output?"),
        {
          type: "tool-sparky__ask_user",
          toolCallId: "call-plain",
          state: "output-available",
          output: { content: "plain output" },
        },
      ] as UIMessage["parts"],
      getToolShortName,
    });

    expect(groups).toEqual([]);
  });

  it("does not consume a separated terminal error after an ask_user input", () => {
    const groups = identifyAskUserGroups({
      messageId: "assistant-1",
      parts: [
        askUserInput("call-failed", "Will this fail?"),
        {
          type: "tool-sparky__ask_user",
          toolCallId: "call-failed",
          state: "output-error",
          errorText: "Request failed",
        },
      ] as UIMessage["parts"],
      getToolShortName,
    });

    expect(groups).toEqual([]);
  });
});

function getToolShortName(toolName: string) {
  return toolName === "sparky__ask_user" ? "ask_user" : null;
}

function askUserInput(toolCallId: string, question: string) {
  return {
    type: "tool-sparky__ask_user",
    toolCallId,
    state: "input-available",
    input: { question },
  };
}

function askUserResult(toolCallId: string, selected: string) {
  return {
    type: "tool-sparky__ask_user",
    toolCallId,
    state: "output-available",
    output: { structuredContent: { action: "accept", selected: [selected] } },
  };
}

function otherTool(toolCallId: string) {
  return {
    type: "tool-search__run",
    toolCallId,
    state: "input-available",
    input: {},
  };
}
