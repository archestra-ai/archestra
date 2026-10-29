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
