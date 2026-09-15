import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import { AgentModel, InteractionModel, ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import interactionRoutes from "../../interaction";
import openrouterProxyRoutes from "./openrouter";

describe("OpenRouter proxy routes", () => {
  test.for([
    { stream: false, cost: 0.0123 },
    { stream: false, cost: 0 },
    { stream: true, cost: 0.0123 },
    { stream: true, cost: 0 },
  ])("preserves reported cost $cost with stream=$stream through proxy and interaction detail", async ({
    stream,
    cost,
  }, { makeOrganization, makeAdmin, makeMember }) => {
    const user = await makeAdmin();
    const agent = await AgentModel.getOrgLlmProxy(
      (await makeOrganization()).id,
    );
    await makeMember(user.id, agent.organizationId, { role: "admin" });
    await ModelModel.upsert({
      externalId: "openrouter/openai/gpt-4o",
      provider: "openrouter",
      modelId: "openai/gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2",
      customPricePerMillionOutput: "3",
      lastSyncedAt: new Date(),
    });
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cost,
    };
    const metadata = {
      id: "chatcmpl-reported-cost",
      created: 0,
      model: "openai/gpt-4o",
    };
    const upstream = Fastify();
    upstream.post("/chat/completions", (_request, reply) => {
      if (stream) {
        const chunks = [
          {
            ...metadata,
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { content: "Hello" }, finish_reason: null },
            ],
          },
          {
            ...metadata,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          {
            ...metadata,
            object: "chat.completion.chunk",
            choices: [],
            usage,
          },
        ];
        return reply
          .type("text/event-stream")
          .send(
            `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          );
      }
      return {
        ...metadata,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage,
      };
    });
    config.llm.openrouter.baseUrl = await upstream.listen({
      port: 0,
      host: "127.0.0.1",
    });
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId: agent.organizationId });
    });
    await app.register(openrouterProxyRoutes);
    await app.register(interactionRoutes);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openrouter/${agent.id}/chat/completions`,
        headers: { authorization: "Bearer test-openrouter-key" },
        payload: {
          model: metadata.model,
          messages: [{ role: "user", content: "Hello" }],
          stream,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const responseUsage = stream
        ? response.body
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .map((line) => JSON.parse(line.slice(6)))
            .findLast((chunk) => chunk.usage)?.usage
        : response.json().usage;
      expect(responseUsage).toEqual(usage);

      await expect
        .poll(
          async () =>
            (await InteractionModel.getAllInteractionsForProfile(agent.id))
              .length,
        )
        .toBe(1);
      const [interaction] = await InteractionModel.getAllInteractionsForProfile(
        agent.id,
      );
      const detail = await app.inject({
        method: "GET",
        url: `/api/interactions/${interaction.id}`,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().response.usage).toEqual(usage);
      expect(detail.json()).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
      });
      expect(Number(detail.json().cost)).toBeCloseTo(0.00026, 8);
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  test("adds configured defaults without replacing caller attribution", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const upstream = Fastify();
    upstream.get("/credits", (request) => {
      receivedHeaders = request.headers;
      return { data: { total_credits: 1 } };
    });
    config.llm.openrouter.baseUrl = await upstream.listen({
      port: 0,
      host: "127.0.0.1",
    });
    config.llm.openrouter.referer = "https://deployment.example";
    config.llm.openrouter.title = "Deployment";
    config.llm.openrouter.categories = "productivity";

    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(openrouterProxyRoutes);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/openrouter/credits",
        headers: {
          authorization: "Bearer test-openrouter-key",
          "x-openrouter-title": "Caller",
          "x-custom-auth": "keep-me",
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(receivedHeaders["http-referer"]).toBe(
        "https://deployment.example",
      );
      expect(receivedHeaders["x-openrouter-title"]).toBe("Caller");
      expect(receivedHeaders["x-title"]).toBeUndefined();
      expect(receivedHeaders["x-openrouter-categories"]).toBe("productivity");
      expect(receivedHeaders["x-custom-auth"]).toBe("keep-me");
    } finally {
      await app.close();
      await upstream.close();
    }
  });
});
