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
  ])("preserves $name tool calls", async ({ toolCalls }, { makeAgent }) => {
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
    server.use(
      http.post(`${upstreamUrl}/chat/completions`, () =>
        HttpResponse.json({
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
        }),
      ),
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/vllm/${agent.id}/chat/completions`,
        headers: { authorization: "Bearer synthetic-test-key" },
        payload: {
          model: "synthetic-model",
          messages: [{ role: "user", content: "Say hello." }],
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
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().choices[0].message).toEqual(message);
      expect(response.json().usage.total_tokens).toBe(9);
    } finally {
      await app.close();
    }
  });
});
