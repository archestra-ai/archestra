import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { internalCallHeader } from "@/clients/internal-call";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createOpenAiTestClient,
  type OpenAiStubOptions,
} from "@/test/llm-provider-stubs";
import type { Agent } from "@/types";
import { ApiError } from "@/types";
import { openaiAdapterFactory } from "./adapters";
import ollamaProxyRoutes from "./routes/ollama";
import openAiProxyRoutes from "./routes/openai";

/**
 * Localhost is not a credential. A keyless call reaches the proxy as an
 * internal caller only with the in-process proof, which nothing outside this
 * process can produce.
 */
describe("LLM proxy internal proof", () => {
  let app: FastifyInstance;
  let testAgent: Agent;
  let openAiStubOptions: OpenAiStubOptions;

  beforeEach(async ({ makeAgent }) => {
    vi.clearAllMocks();
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) =>
      reply.status(error instanceof ApiError ? error.statusCode : 500).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type:
            error instanceof ApiError
              ? error.type
              : "api_internal_server_error",
        },
      }),
    );
    openAiStubOptions = {};
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient(openAiStubOptions) as never,
    );
    testAgent = await makeAgent({ name: "Internal proof agent" });
    await app.register(ollamaProxyRoutes);
    await app.register(openAiProxyRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const keylessRequest = (headers: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: `/v1/ollama/${testAgent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/json", ...headers },
      payload: {
        model: "llama3",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      },
    });

  test("a keyless call from localhost without the proof is rejected", async () => {
    const response = await keylessRequest({});

    expect(response.statusCode, response.body).toBe(401);
  });

  test("a forged proof value is rejected", async () => {
    const response = await keylessRequest({
      "x-archestra-internal-call": "not-the-process-secret",
    });

    expect(response.statusCode, response.body).toBe(401);
  });

  test("a call carrying the process's own proof is accepted", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${testAgent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        ...internalCallHeader(),
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
  });
});
