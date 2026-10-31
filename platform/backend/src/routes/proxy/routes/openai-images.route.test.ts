import { HttpResponse, http } from "msw";
import sharp from "sharp";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel, ModelModel } from "@/models";
import OrganizationModel from "@/models/organization";
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
      expect(streaming.json().error.message).toContain(
        "Image streaming is not supported. Omit stream or set it to false.",
      );
    } finally {
      await app.close();
    }
  });

  test("governs OpenAI image edits with the caller's key, forwarding the exact upload bytes", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    config.llm.openai.baseUrl = "https://openai.example/v1";
    config.llmProxy.plugins = [];
    const agent = await makeAgent({ isDefault: true, agentType: "llm_proxy" });
    // Logs keep media only when the organization turns it on.
    await OrganizationModel.patch(agent.organizationId, {
      keepMediaInLogs: true,
    });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const token = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: user.id,
    });
    const image = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    let forwarded: FormData | undefined;
    server.use(
      http.post(
        "https://openai.example/v1/images/edits",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer openai-key",
          );
          forwarded = await request.formData();
          return HttpResponse.json({
            created: 1,
            data: [{ b64_json: "aW1hZ2U=" }],
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          });
        },
      ),
    );
    const form = new FormData();
    form.append("model", "gpt-image-1");
    form.append("prompt", "Make it red.");
    form.append(
      "image",
      new File([image], "reference.png", { type: "image/png" }),
    );
    const encoded = new Request("http://form.test", {
      method: "POST",
      body: form,
    });
    const app = createFastifyInstance();
    await app.register(openAiRoutes);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai${withAgent ? `/${agent.id}` : ""}/images/edits`,
        headers: {
          authorization: "Bearer openai-key",
          "x-archestra-virtual-key": token,
          "content-type": String(encoded.headers.get("content-type")),
        },
        payload: Buffer.from(await encoded.arrayBuffer()),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data[0].b64_json).toBe("aW1hZ2U=");
      expect(forwarded?.get("model")).toBe("gpt-image-1");
      expect(forwarded?.get("prompt")).toBe("Make it red.");
      const sent = forwarded?.get("image") as File;
      expect(Buffer.from(await sent.arrayBuffer()).equals(image)).toBe(true);
      const interactions = await InteractionModel.getAllInteractionsForProfile(
        agent.id,
      );
      expect(interactions.at(-1)).toMatchObject({
        type: "openai:images",
        model: "gpt-image-1",
        inputTokens: 2,
        outputTokens: 3,
        request: {
          prompt: "Make it red.",
          metadata: { operation: "image-edit" },
        },
      });
      // The row keeps the uploaded image, with its metadata, for Logs.
      expect(
        (
          interactions.at(-1)?.request as {
            input_files?: { images?: Array<{ data?: string }> };
          }
        ).input_files?.images?.[0]?.data,
      ).toBe(image.toString("base64"));
    } finally {
      await app.close();
    }
  });
});
