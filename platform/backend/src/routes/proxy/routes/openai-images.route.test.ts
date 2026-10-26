import { HttpResponse, http } from "msw";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel, ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { useMswServer } from "@/test/msw";
import openAiRoutes from "./openai";

// biome-ignore lint/correctness/useHookAtTopLevel: This registers Vitest lifecycle hooks, not React hooks.
const server = useMswServer();

describe.each([
  false,
  true,
])("OpenAI image routing (agent path: %s)", (withAgent) => {
  test("governs the native Images API instead of forwarding it raw, and logs the media interaction", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    config.llm.openai.baseUrl = "https://openai.example/v1";
    config.llmProxy.plugins = [];
    const agent = await makeAgent({ isDefault: true, agentType: "llm_proxy" });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const token = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: user.id,
    });
    await ModelModel.upsert({
      externalId: "openai/gpt-image-1",
      provider: "openai",
      modelId: "gpt-image-1",
      inputModalities: ["text"],
      outputModalities: ["image"],
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "1",
      lastSyncedAt: new Date(),
    });
    server.use(
      http.post(
        "https://openai.example/v1/images/generations",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer openai-key",
          );
          expect(new URL(request.url).search).toBe("");
          expect(await request.json()).toMatchObject({
            model: "gpt-image-1",
            prompt: "Draw a circle.",
            stream: false,
          });
          return HttpResponse.json({
            created: 1,
            data: [{ b64_json: "aW1hZ2U=" }],
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          });
        },
      ),
    );
    const app = createFastifyInstance();
    await app.register(openAiRoutes);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai${withAgent ? `/${agent.id}` : ""}/images/generations`,
        headers: {
          authorization: "Bearer openai-key",
          "x-archestra-virtual-key": token,
          "user-agent": "test-client",
        },
        payload: { model: "gpt-image-1", prompt: "Draw a circle." },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data[0].b64_json).toBe("aW1hZ2U=");
      const interactions = await InteractionModel.getAllInteractionsForProfile(
        agent.id,
      );
      expect(interactions.at(-1)).toMatchObject({
        type: "openai:images",
        model: "gpt-image-1",
        inputTokens: 2,
        outputTokens: 3,
        request: { prompt: "Draw a circle." },
      });
      // A provider key alone no longer reaches the upstream through the catch-all.
      const anonymous = await app.inject({
        method: "POST",
        url: "/v1/openai/images/generations",
        headers: { authorization: "Bearer openai-key" },
        payload: { model: "gpt-image-1", prompt: "Draw a circle." },
      });
      expect(anonymous.statusCode).toBe(401);
      const streaming = await app.inject({
        method: "POST",
        url: "/v1/openai/images/generations",
        headers: {
          authorization: "Bearer openai-key",
          "x-archestra-virtual-key": token,
        },
        payload: {
          model: "gpt-image-1",
          prompt: "Draw a circle.",
          stream: true,
        },
      });
      expect(streaming.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
