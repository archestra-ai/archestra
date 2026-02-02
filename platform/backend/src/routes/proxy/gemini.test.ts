import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import { AgentModel, TokenPriceModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import { ApiError } from "@/types";

function createTestApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send({
        error: {
          message: error.message,
          type: error.type,
        },
      });
      return;
    }
    reply.send(error);
  });
  return app;
}

describe("Gemini proxy streaming", () => {
  let response: Awaited<ReturnType<FastifyInstance["inject"]>>;
  let chunks: any[] = [];
  
  beforeEach(async () => {
    // Create a test Fastify app
    const app = createTestApp();

    const geminiProxyRoutes = (await import("./gemini")).default;
    await app.register(geminiProxyRoutes);
    // Needed for limiting checks
    config.benchmark.mockMode = true;

    // Make a streaming request to the route
    response = await app.inject({
      method: "POST",
      url: "/v1/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "test-key",
        "user-agent": "test-client",
      },
      payload: {
        contents: [{ role: "user", parts: [{ text: "Hello!" }] }],
      },
    });

    chunks = response.body
      .split("\n\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.substring(6)));
  });

  test("response has stream content type", async () => {
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
  });

  test("chunks have correct structure", () => {
    // Check if chunks look like Gemini REST response
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].candidates[0].content.parts[0]).toBeDefined();
  });
});

describe("Gemini cost tracking", () => {
  test("stores cost and baselineCost in interaction", async () => {
    const app = createTestApp();

    const geminiProxyRoutes = (await import("./gemini")).default;
    await app.register(geminiProxyRoutes);
    config.benchmark.mockMode = true;

    // Create token pricing for the model
    await TokenPriceModel.create({
      provider: "gemini",
      model: "gemini-1.5-pro",
      pricePerMillionInput: "3.50",
      pricePerMillionOutput: "10.50",
    });

    // Create a test agent
    const agent = await AgentModel.create({
      name: "Test Gemini Cost Agent",
      teams: [],
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/v1beta/models/gemini-2.5-pro:generateContent`,
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": "test-key",
        "user-agent": "test-client",
      },
      payload: {
        contents: [{ role: "user", parts: [{ text: "Hello!" }] }],
      },
    });

    if (response.statusCode !== 200) {
        console.log("Response body:", response.body);
    }
    expect(response.statusCode).toBe(200);

    // Find the created interaction
    const { InteractionModel } = await import("@/models");
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBeGreaterThan(0);

    const interaction = interactions[interactions.length - 1];
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
    expect(interaction.model).toBe("gemini-2.5-pro");
  });
});

describe("Gemini authentication", () => {
  test("returns 400 for missing API key", async () => {
    const app = createTestApp();

    const geminiProxyRoutes = (await import("./gemini")).default;
    await app.register(geminiProxyRoutes);
    // Disable mock mode to test real client creation (which checks invalid API key)
    config.benchmark.mockMode = false;

    const response = await app.inject({
      method: "POST",
      url: "/v1/gemini/v1beta/models/gemini-2.5-pro:generateContent",
      headers: {
        "content-type": "application/json",
        // No x-goog-api-key
        "user-agent": "test-client",
      },
      payload: {
        contents: [{ role: "user", parts: [{ text: "Hello!" }] }],
      },
    });
    
    expect(response.statusCode).toBe(400);
  });
});
