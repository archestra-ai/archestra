import type { FastifyRequest } from "fastify";
import { describe, expect, test } from "vitest";
import { scrubOpenappaIngress, scrubTranslatedClientWire } from "./ingress";

const kiloHeaders = {
  "user-agent": "kilo/7.8.12",
  "x-archestra-agent-id": "kilo",
  "x-opencode-session": "ses_root",
};
const carrier = "CHILD-ANSWER\n\n▄█▄▄▄█▄\n██▄█▄██  finished subagent ABC-DEFG";
const taskResult = `<task id="ses_child" state="completed">\n<summary>UNTRUSTED SUMMARY</summary>\n<task_result>\n${carrier}\n</task_result>\n</task>`;

test.each([
  "openai:responses",
  "openai:chatCompletions",
] as const)("%s memory cleanup preserves exact child bytes and does not adopt embedded receipts", (family) => {
  const child = "00000000-0000-4000-8000-000000000001";
  const value = "\n  EXACT_CHILD_VALUE\n";
  const entries = [
    {
      type: "assistant",
      content: "▄█▄▄▄█▄  protected session ABC-DEFG\n\nCalling child",
      tool_calls: [{ id: "spawn", name: "spawn_subagent", arguments: "{}" }],
    },
    {
      type: "tool_result",
      tool_call_id: "spawn",
      content: `▄█▄▄▄█▄  started subagent ABC-DEFG@aaaaaaaaaaaaaaaaaaaaaa\n\n${value}\n\n▄█▄▄▄█▄  finished subagent ABC-DEFG\n\n<subagent_result>\nsubagent_id: ${child}\nTo continue this subagent's conversation, use resume_from="${child}".\n</subagent_result>`,
    },
  ];
  const text =
    "session_id=synthetic-root\nfrom_turn=1\nthrough_turn=1\ndurable_conversation_json:\n" +
    JSON.stringify(entries);
  const messages = [{ role: "user", content: text }];
  const body =
    family === "openai:responses" ? { input: messages } : { messages };
  const request = {
    headers: {
      "x-grok-client-identifier": "grok-shell",
      "x-grok-session-id": "synthetic-root",
    },
    url: "/v1/xai/agent/responses",
  } as unknown as FastifyRequest;
  for (let replay = 0; replay < 2; replay++) {
    const ingress = scrubOpenappaIngress({
      request,
      body,
      interactionType: family,
    });
    expect(ingress.childReturnRefusal).toBeUndefined();
    expect(ingress.childReturns?.completions).toEqual([
      expect.objectContaining({
        value,
        childNativeId: child,
        envelopeId: "spawn",
        assistantOrigin: false,
      }),
    ]);
    expect(ingress.strippedReceiptCodes).toEqual([]);
    expect(ingress.childTrajectoryReferences).toEqual([]);
    expect(ingress.childTrajectoryReceipts ?? []).toEqual([]);
    expect(messages[0].content).not.toContain("subagent_result");
    expect(messages[0].content).not.toContain("▄█▄▄▄█▄");
  }
});

test.each([
  "grok-shell",
  "grok-pager",
])("%s turn summaries are compaction requests, so they cannot finish a child", (identifier) => {
  const request = {
    headers: {
      "x-grok-client-identifier": identifier,
      "x-grok-session-id": "synthetic-child",
      "x-grok-conv-id": "turn-summary-synthetic",
    },
    url: "/v1/xai/agent/responses",
  } as unknown as FastifyRequest;
  expect(
    scrubOpenappaIngress({
      request,
      body: { input: [{ role: "user", content: "Summarize the prior turn." }] },
      interactionType: "openai:responses",
    }).clientCompaction,
  ).toBe(true);
});

describe("ingress on a Model Router translated wire", () => {
  test("uses what the route collected from the client's wire", () => {
    const request = fakeRequest();
    const chatBody = chatWithTaskResult("gemsig-c2lnbmF0dXJl.call_task");
    scrubTranslatedClientWire({
      request,
      family: "openai:chatCompletions",
      body: chatBody,
      translatedCallId: (callId) => callId.replace(/^gemsig-[^.]+\./, ""),
    });
    // The route strips the carrier before it translates the body.
    expect(JSON.stringify(chatBody)).not.toContain("UNTRUSTED SUMMARY");
    expect(JSON.stringify(chatBody)).not.toContain("finished subagent");

    const ingress = scrubOpenappaIngress({
      request,
      body: { contents: [] },
      interactionType: "gemini:generateContent",
    });
    expect(ingress.childReturns?.completions).toEqual([
      expect.objectContaining({
        value: "CHILD-ANSWER",
        envelopeId: "call_task",
        childNativeId: "ses_child",
      }),
    ]);
    expect(ingress.delegationMarkers).toEqual([]);
    expect(ingress.clientWire).toEqual({
      family: "openai:chatCompletions",
      body: chatBody,
    });
  });

  test("reads an OpenAPPA wire itself, whatever a route collected", () => {
    const request = fakeRequest();
    scrubTranslatedClientWire({
      request,
      family: "openai:chatCompletions",
      body: chatWithTaskResult("call_from_route"),
    });
    const ingress = scrubOpenappaIngress({
      request,
      body: chatWithTaskResult("call_own"),
      interactionType: "openai:chatCompletions",
    });
    expect(ingress.childReturns?.completions).toEqual([
      expect.objectContaining({ envelopeId: "call_own" }),
    ]);
    expect(ingress.clientWire).toBeUndefined();
  });

  test("collects nothing on another wire when no route translated it", () => {
    const ingress = scrubOpenappaIngress({
      request: fakeRequest(),
      body: { contents: [] },
      interactionType: "gemini:generateContent",
    });
    expect(ingress.childReturns).toBeUndefined();
    expect(ingress.delegationMarkers).toBeUndefined();
    expect(ingress.clientWire).toBeUndefined();
  });
});

function fakeRequest(): FastifyRequest {
  return {
    headers: { ...kiloHeaders },
    url: "/v1/model-router/agent/chat/completions",
  } as unknown as FastifyRequest;
}

function chatWithTaskResult(callId: string) {
  return {
    model: "gemini-test-model",
    messages: [
      { role: "user", content: "Delegate the investigation" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name: "task", arguments: '{"prompt":"Find out"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: callId, content: taskResult },
    ],
  };
}
