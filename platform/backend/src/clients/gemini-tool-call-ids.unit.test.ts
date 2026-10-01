// @vitest-environment node
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { expect, test } from "vitest";

// Exercise the installed provider: changing its response parser or request
// serializer must not break the IDs used to authorize tool results.
test.each([
  false,
  true,
])("Gemini preserves tool IDs through a complete round trip (stream=%s)", async (streaming) => {
  const requests: Array<{ contents: Array<{ parts: unknown[] }> }> = [];
  const reply = {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: { id: "call-first", name: "read_policy", args: {} },
              thoughtSignature: "signature-first",
            },
            {
              functionCall: {
                id: "call-second",
                name: "read_policy",
                args: {},
              },
              thoughtSignature: "signature-second",
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      totalTokenCount: 2,
    },
  };
  const model = createGoogleGenerativeAI({
    apiKey: "test",
    fetch: async (url, init) => {
      const sse = String(url).includes("streamGenerateContent");
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        sse ? `data: ${JSON.stringify(reply)}\n\n` : JSON.stringify(reply),
        {
          headers: {
            "content-type": sse ? "text/event-stream" : "application/json",
          },
        },
      );
    },
  })("gemini-2.5-flash");
  const prompt = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Read policy" }],
    },
  ];
  const content = streaming
    ? await (async () => {
        const { stream } = await model.doStream({ prompt });
        const parts = [];
        for await (const part of stream) parts.push(part);
        return parts;
      })()
    : (await model.doGenerate({ prompt })).content;
  const calls = content.filter((part) => part.type === "tool-call");
  expect(calls.map((call) => call.toolCallId)).toEqual([
    "call-first",
    "call-second",
  ]);
  await model.doGenerate({
    prompt: [
      ...prompt,
      {
        role: "assistant",
        content: calls.map((call) => ({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: {},
          providerOptions: call.providerMetadata,
        })),
      },
      {
        role: "tool",
        content: calls.map((call) => ({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "json", value: { revision: 1 } },
        })),
      },
    ],
  });
  expect(requests[1].contents[1].parts).toEqual(
    calls.map((call, index) => ({
      functionCall: { id: call.toolCallId, name: "read_policy", args: {} },
      thoughtSignature: index === 0 ? "signature-first" : "signature-second",
    })),
  );
  expect(requests[1].contents[2].parts).toEqual(
    calls.map((call) => ({
      functionResponse: {
        id: call.toolCallId,
        name: "read_policy",
        response: { name: "read_policy", content: { revision: 1 } },
      },
    })),
  );
});
