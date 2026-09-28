import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import config from "@/config";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import vllmProxyRoutes from "./vllm";

const upstreamUrl = "http://vllm.example.test/v1";
const toolCall = {
  id: "call_weather",
  type: "function",
  function: { name: "weather", arguments: '{"city":"Example City"}' },
};

// biome-ignore lint/correctness/useHookAtTopLevel: per-test MSW lifecycle helper
const server = useMswServer();

describe("vLLM proxy response serialization", () => {
  test.for([
    { name: "null", toolCalls: null },
    { name: "omitted", toolCalls: undefined },
    { name: "empty", toolCalls: [] },
    { name: "populated", toolCalls: [toolCall] },
  ])("round-trips $name tool calls", async ({ toolCalls }, { makeAgent }) => {
    config.llm.vllm.enabled = true;
    config.llm.vllm.baseUrl = upstreamUrl;
    const agent = await makeAgent({ agentType: "llm_proxy" });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(vllmProxyRoutes);

    const message = {
      role: "assistant",
      content: toolCalls?.length ? null : "Hello from a synthetic model.",
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    };
    let upstreamMessages: unknown;
    server.use(
      http.post(`${upstreamUrl}/chat/completions`, async ({ request }) => {
        upstreamMessages = ((await request.json()) as { messages: unknown })
          .messages;
        return HttpResponse.json({
          id: "chatcmpl-synthetic",
          object: "chat.completion",
          created: 1700000000,
          model: "synthetic-model",
          choices: [
            {
              index: 0,
              finish_reason: toolCalls?.length ? "tool_calls" : "stop",
              logprobs: null,
              message,
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        });
      }),
    );

    try {
      const messages: Record<string, unknown>[] = [
        { role: "user", content: "Say hello." },
      ];
      const request = {
        method: "POST",
        url: `/v1/vllm/${agent.id}/chat/completions`,
        headers: { authorization: "Bearer synthetic-test-key" },
        payload: {
          model: "synthetic-model",
          messages,
          ...(toolCalls?.length
            ? {
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "weather",
                      parameters: {
                        type: "object",
                        properties: { city: { type: "string" } },
                      },
                    },
                  },
                ],
              }
            : {}),
        },
      } as const;
      const response = await app.inject(request);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().choices[0].message).toEqual(message);
      expect(response.json().usage.total_tokens).toBe(9);
      expect(upstreamMessages).toEqual(messages);

      messages.push(response.json().choices[0].message);
      if (toolCalls?.length) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Sunny.",
        });
      }
      messages.push({ role: "user", content: "Please continue." });
      const followUp = await app.inject(request);
      expect(followUp.statusCode, followUp.body).toBe(200);
      expect(upstreamMessages).toEqual(messages);
      expect(followUp.json().choices[0].message).toEqual(message);
    } finally {
      await app.close();
    }
  });
});
