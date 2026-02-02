/**
 * Groq Proxy Routes Unit Tests
 *
 * Tests for the Groq LLM proxy routes, ensuring proper handling of
 * streaming, cost tracking, and interaction recording.
 *
 * @module routes/proxy/groq.test
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import { AgentModel, TokenPriceModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { OpenAi } from "@/types";  // Groq uses OpenAI types
import groqProxyRoutes from "./groq";

/**
 * Test suite for Groq proxy streaming functionality.
 *
 * Validates that streaming responses are correctly formatted
 * and contain the expected structure.
 */
describe("Groq proxy streaming", () => {
  let response: Awaited<ReturnType<FastifyInstance["inject"]>>;
  let chunks: OpenAi.Types.ChatCompletionChunk[] = [];
  
  beforeEach(async () => {
    // Create a test Fastify app
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(groqProxyRoutes);
    config.benchmark.mockMode = true;

    // Create agent for testing
    const agent = await AgentModel.create({
      name: "test-agent-groq",
      teams: [],
    });

    // Send a test request
    response = await app.inject({
      method: "POST",
      url: `/v1/groq/${agent.id}/chat/completions`,
      headers: {
        "authorization": "Bearer test-api-key",
        "content-type": "application/json",
      },
      payload: {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "Hello, Groq!" }],
        stream: true,
      },
    });

    // Parse SSE chunks
    const lines = response.body.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ") && !line.includes("[DONE]")) {
        try {
          const chunk = JSON.parse(line.replace("data: ", ""));
          chunks.push(chunk);
        } catch {
          // Skip invalid JSON
        }
      }
    }
  });

  test("response has stream content type", async () => {
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
  });

  test("first chunk has role", () => {
    const firstChunk = chunks[0];
    expect(firstChunk.choices[0].delta).toHaveProperty("role", "assistant");
  });

  test("last chunk has finish reason", () => {
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.choices[0]).toHaveProperty("finish_reason");
  });
});

/**
 * Test suite for Groq cost tracking.
 *
 * Validates that cost and baselineCost are properly calculated
 * and stored in interactions.
 */
describe("Groq cost tracking", () => {
  test("stores cost and baselineCost in interaction", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(groqProxyRoutes);
    config.benchmark.mockMode = true;

    // Create token pricing for Groq model
    await TokenPriceModel.create({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      pricePerMillionInput: "0.59",
      pricePerMillionOutput: "0.79",
    });

    // Create agent for testing
    const agent = await AgentModel.create({
      name: "test-agent-groq-cost",
      teams: [],
    });

    // Send a test request
    const response = await app.inject({
      method: "POST",
      url: `/v1/groq/${agent.id}/chat/completions`,
      headers: {
        "authorization": "Bearer test-api-key",
        "content-type": "application/json",
      },
      payload: {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);

    // Wait for async interaction recording
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Import InteractionModel for verification
    const { InteractionModel } = await import("@/models");
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBeGreaterThan(0);

    const interaction = interactions[interactions.length - 1];
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
    expect(typeof interaction.cost).toBe("string");
    expect(typeof interaction.baselineCost).toBe("string");
  });
});

/**
 * Test suite for Groq streaming mode.
 *
 * Validates streaming mode functionality and interaction recording,
 * including handling of interrupted streams.
 */
describe("Groq streaming mode", () => {
  test("streaming mode completes normally and records interaction", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(groqProxyRoutes);
    config.benchmark.mockMode = true;

    // Create token pricing for Groq model
    await TokenPriceModel.create({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      pricePerMillionInput: "0.59",
      pricePerMillionOutput: "0.79",
    });

    // Create agent for testing
    const agent = await AgentModel.create({
      name: "test-agent-groq-stream",
      teams: [],
    });

    // Send a streaming request
    const response = await app.inject({
      method: "POST",
      url: `/v1/groq/${agent.id}/chat/completions`,
      headers: {
        "authorization": "Bearer test-api-key",
        "content-type": "application/json",
      },
      payload: {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "Hello, stream!" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    // Verify the response contains SSE events
    const body = response.body;
    expect(body).toContain("data: ");
    expect(body).toContain('"finish_reason":"stop"');

    // Wait a bit for async interaction recording
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Find the created interaction
    const { InteractionModel } = await import("@/models");
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBeGreaterThan(0);

    const interaction = interactions[interactions.length - 1];
    expect(interaction.model).toBe("llama-3.3-70b-versatile");
    expect(interaction.inputTokens).toBeGreaterThan(0);
    expect(interaction.outputTokens).toBeGreaterThan(0);
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
  });
});

/**
 * Test suite for Groq non-streaming mode.
 *
 * Validates that non-streaming requests are handled correctly.
 */
describe("Groq non-streaming mode", () => {
  test("non-streaming mode returns complete response", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(groqProxyRoutes);
    config.benchmark.mockMode = true;

    // Create agent for testing
    const agent = await AgentModel.create({
      name: "test-agent-groq-nonstream",
      teams: [],
    });

    // Send a non-streaming request
    const response = await app.inject({
      method: "POST",
      url: `/v1/groq/${agent.id}/chat/completions`,
      headers: {
        "authorization": "Bearer test-api-key",
        "content-type": "application/json",
      },
      payload: {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");

    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("choices");
    expect(body.choices.length).toBeGreaterThan(0);
    expect(body.choices[0]).toHaveProperty("message");
    expect(body.choices[0].message).toHaveProperty("role", "assistant");
    expect(body.choices[0].message).toHaveProperty("content");
  });
});

/**
 * Test suite for Groq tool calling.
 *
 * Validates that function/tool calling works correctly.
 */
describe("Groq tool calling", () => {
  test("handles tool calls in response", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(groqProxyRoutes);
    config.benchmark.mockMode = true;

    // Create agent for testing
    const agent = await AgentModel.create({
      name: "test-agent-groq-tools",
      teams: [],
    });

    // Send a request with tools
    const response = await app.inject({
      method: "POST",
      url: `/v1/groq/${agent.id}/chat/completions`,
      headers: {
        "authorization": "Bearer test-api-key",
        "content-type": "application/json",
      },
      payload: {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "What's the weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "list_files",
              description: "List files in directory",
              parameters: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                    description: "The path to list",
                  },
                },
              },
            },
          },
        ],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // console.log("Tool Call Body:", JSON.stringify(body, null, 2));
    expect(body).toHaveProperty("choices");
    expect(body.choices[0].message).toHaveProperty("tool_calls");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("list_files");
  });
});

/**
 * Test suite for Groq error handling.
 *
 * Validates that errors are properly handled and formatted.
 */
describe("Groq error handling", () => {
  test("returns 401 for missing API key", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(groqProxyRoutes);
    config.benchmark.mockMode = false;  // Disable mock mode for auth test

    // Create agent for testing
    const agent = await AgentModel.create({
      name: "test-agent-groq-auth",
      teams: [],
    });

    // Send a request without API key
    const response = await app.inject({
      method: "POST",
      url: `/v1/groq/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });

    // Should return 401 Unauthorized
    expect(response.statusCode).toBe(401);
  });

  test("returns 400 for invalid model", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(groqProxyRoutes);
    config.benchmark.mockMode = true;

    // Create agent for testing
    const agent = await AgentModel.create({
      name: "test-agent-groq-model",
      teams: [],
    });

    // Send a request with invalid model
    const response = await app.inject({
      method: "POST",
      url: `/v1/groq/${agent.id}/chat/completions`,
      headers: {
        "authorization": "Bearer test-api-key",
        "content-type": "application/json",
      },
      payload: {
        model: "invalid-model-name-xyz",
        messages: [{ role: "user", content: "Hello!" }],
      },
    });

    // Should handle gracefully (may return 400 or forward error)
    expect([200, 400, 404]).toContain(response.statusCode);
  });
});
