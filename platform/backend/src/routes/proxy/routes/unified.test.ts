import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { 
  openaiAdapterFactory, 
  anthropicAdapterFactory, 
  geminiAdapterFactory 
} from "../adapters";
import unifiedProxyRoutes from "./unified";

describe("Unified LLM Proxy", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(unifiedProxyRoutes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("routes gpt-4o-mini to OpenAI factory", async ({ makeAgent }) => {
    const spy = vi.spyOn(openaiAdapterFactory, "execute").mockResolvedValue({
      id: "test-id",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4o-mini",
      choices: [{ 
        index: 0,
        message: { role: "assistant", content: "OpenAI response" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
    } as any);

    const agent = await makeAgent({ 
      name: "Unified Agent",
      agentType: "profile",
      isDefault: true
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
      headers: {
        authorization: "Bearer sk-test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(spy).toHaveBeenCalled();
    const body = JSON.parse(response.body);
    expect(body.choices[0].message.content).toBe("OpenAI response");
  });

  test("routes default agent request to correct factory", async ({ makeAgent }) => {
    const spy = vi.spyOn(openaiAdapterFactory, "execute").mockResolvedValue({
      id: "test-id",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4o-mini",
      choices: [{ 
        index: 0,
        message: { role: "assistant", content: "Default agent response" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
    } as any);

    await makeAgent({ 
      name: "Default Agent",
      agentType: "profile",
      isDefault: true
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/unified/chat/completions",
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
      headers: {
        authorization: "Bearer sk-test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(spy).toHaveBeenCalled();
    const body = JSON.parse(response.body);
    expect(body.choices[0].message.content).toBe("Default agent response");
  });

  test("routes claude-3-sonnet to Anthropic factory with translation", async ({ makeAgent }) => {
    const spy = vi.spyOn(anthropicAdapterFactory, "execute").mockResolvedValue({
      id: "ant-id",
      content: [{ type: "text", text: "Anthropic response" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    } as any);

    const agent = await makeAgent({ name: "Unified Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      payload: {
        model: "claude-3-sonnet",
        messages: [{ role: "user", content: "Hello" }],
      },
      headers: {
        authorization: "Bearer sk-test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(spy).toHaveBeenCalled();
    
    // Check if the request was translated
    const callArgs = spy.mock.calls[0][1];
    expect(callArgs.model).toBe("claude-3-sonnet");
    expect(callArgs.messages[0].role).toBe("user");

    const body = JSON.parse(response.body);
    expect(body.choices[0].message.content).toBe("Anthropic response");
    expect(body.usage.total_tokens).toBe(30);
    expect(body.model).toBe("claude-3-sonnet");
  });

  test("routes gemini-1.5-pro to Gemini factory with translation", async ({ makeAgent }) => {
    const spy = vi.spyOn(geminiAdapterFactory, "execute").mockResolvedValue({
      candidates: [{ content: { parts: [{ text: "Gemini response" }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
    } as any);

    const agent = await makeAgent({ name: "Unified Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      payload: {
        model: "gemini-1.5-pro",
        messages: [{ role: "user", content: "Hello" }],
      },
      headers: {
        authorization: "Bearer sk-test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(spy).toHaveBeenCalled();
    
    const body = JSON.parse(response.body);
    expect(body.choices[0].message.content).toBe("Gemini response");
    expect(body.usage.total_tokens).toBe(10);
  });
  test("routes claude-3-sonnet streaming with translation", async ({ makeAgent }) => {
    const mockStream = (async function* () {
      yield { type: "message_start", message: { role: "assistant" } };
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Anthropic Stream" } };
      yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } };
      yield { type: "message_stop" };
    })();

    const spy = vi.spyOn(anthropicAdapterFactory, "executeStream").mockResolvedValue(mockStream as any);

    const agent = await makeAgent({ name: "Unified Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/unified/${agent.id}/chat/completions`,
      payload: {
        model: "claude-3-sonnet",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      },
      headers: {
        authorization: "Bearer sk-test",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(spy).toHaveBeenCalled();
    
    // Check for OpenAI-compatible SSE chunks
    expect(response.body).toContain("data: {\"id\":\"chatcmpl-");
    expect(response.body).toContain("\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}");
    expect(response.body).toContain("Hello from Anthropic Stream");
    expect(response.body).toContain("data: [DONE]");
  });
});
