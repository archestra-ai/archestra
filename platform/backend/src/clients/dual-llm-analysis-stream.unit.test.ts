import { DUAL_LLM_ANALYSIS_PART_TYPE } from "@archestra/shared";
import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "vitest";
import type { DualLlmProgressEvent } from "@/guardrails/dual-llm-progress-bus";
import type { ChatMessage, ChatMessagePart } from "@/types";
import {
  applyDualLlmAnalysesToMessages,
  createDualLlmAnalysisStreamBridge,
} from "./dual-llm-analysis-stream";

const startEvent: DualLlmProgressEvent = {
  kind: "start",
  toolCallId: "call_1",
  toolName: "web_fetch",
};

const qaEvent: DualLlmProgressEvent = {
  kind: "qa",
  toolCallId: "call_1",
  toolName: "web_fetch",
  question: "Primary topic?",
  options: ["security", "recipes"],
  answer: "0",
};

const completeEvent: Extract<DualLlmProgressEvent, { kind: "complete" }> = {
  kind: "complete",
  toolCallId: "call_1",
  toolName: "web_fetch",
  analysis: {
    toolCallId: "call_1",
    conversations: [
      { role: "assistant", content: "Primary topic?" },
      { role: "user", content: "0" },
    ],
    result: "A security article.",
  },
  cached: false,
};

describe("createDualLlmAnalysisStreamBridge", () => {
  test("buffers events until the stream starts, then streams reconciling snapshots", () => {
    const bridge = createDualLlmAnalysisStreamBridge();
    const written: UIMessageChunk[] = [];
    bridge.setWriter({ write: (chunk) => written.push(chunk) });

    // Analyses run while the proxy holds the request pre-`start`; nothing may
    // reach the client yet (a pre-`start` data part mints a phantom message).
    bridge.handleEvent(startEvent);
    bridge.handleEvent(qaEvent);
    expect(written).toEqual([]);

    bridge.markStreamStarted();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      type: DUAL_LLM_ANALYSIS_PART_TYPE,
      id: "call_1",
      data: {
        toolCallId: "call_1",
        toolName: "web_fetch",
        status: "analyzing",
        rounds: [
          {
            question: "Primary topic?",
            options: ["security", "recipes"],
            answer: "0",
          },
        ],
      },
    });

    bridge.handleEvent(completeEvent);
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({
      id: "call_1",
      data: {
        status: "done",
        summary: "A security article.",
        cached: false,
        questionCount: 1,
      },
    });

    // A later agentic-loop step re-confirms the same analysis from the
    // sanitize-once cache; the live interrogation must not be relabeled.
    bridge.handleEvent({ ...completeEvent, cached: true });
    expect(written[2]).toMatchObject({
      id: "call_1",
      data: { status: "done", cached: false, questionCount: 1 },
    });
  });

  test("a cached completion carries the original interrogation's round count", () => {
    const bridge = createDualLlmAnalysisStreamBridge();
    bridge.handleEvent({ ...completeEvent, cached: true });

    const [part] = bridge.collected();
    expect(part).toMatchObject({
      type: DUAL_LLM_ANALYSIS_PART_TYPE,
      data: {
        status: "done",
        cached: true,
        rounds: [],
        questionCount: 1,
        summary: "A security article.",
      },
    });
  });

  test("a failure marks the analysis failed with its message", () => {
    const bridge = createDualLlmAnalysisStreamBridge();
    bridge.handleEvent(startEvent);
    bridge.handleEvent({
      kind: "error",
      toolCallId: "call_1",
      toolName: "web_fetch",
      message: "Sanitization failed for web_fetch: provider unavailable",
    });

    const [part] = bridge.collected();
    expect(part).toMatchObject({
      data: {
        status: "failed",
        failureMessage:
          "Sanitization failed for web_fetch: provider unavailable",
      },
    });
  });
});

describe("applyDualLlmAnalysesToMessages", () => {
  const analysisPart = {
    type: DUAL_LLM_ANALYSIS_PART_TYPE,
    data: {
      toolCallId: "call_1",
      toolName: "web_fetch",
      status: "done",
      rounds: [],
      questionCount: 1,
    },
  } as ChatMessagePart;

  test("splices each analysis directly after its tool part", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-web_fetch",
            toolCallId: "call_1",
            state: "output-available",
          },
          { type: "text", text: "answer" },
        ],
      },
    ] as unknown as ChatMessage[];

    const result = applyDualLlmAnalysesToMessages(messages, [analysisPart]);

    expect(result[1].parts?.map((part) => part.type)).toEqual([
      "step-start",
      "tool-web_fetch",
      DUAL_LLM_ANALYSIS_PART_TYPE,
      "text",
    ]);
    // Untouched messages are returned as-is content-wise.
    expect(result[0].parts).toEqual(messages[0].parts);
  });

  test("falls back to the last assistant message when the tool part is absent", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "answer" }] },
    ] as unknown as ChatMessage[];

    const result = applyDualLlmAnalysesToMessages(messages, [analysisPart]);

    expect(result[1].parts?.map((part) => part.type)).toEqual([
      "text",
      DUAL_LLM_ANALYSIS_PART_TYPE,
    ]);
  });

  test("returns the input unchanged when there is nothing to splice", () => {
    const messages = [
      { role: "assistant", parts: [{ type: "text", text: "answer" }] },
    ] as unknown as ChatMessage[];
    expect(applyDualLlmAnalysesToMessages(messages, [])).toBe(messages);
  });
});
