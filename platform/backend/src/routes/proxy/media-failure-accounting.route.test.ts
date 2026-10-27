import { createServer } from "node:http";
import type OpenAI from "openai";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel } from "@/models";
import { expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { Azure } from "@/types";
import { azureImagesAdapterFactory } from "./adapters/azure-images";
import { handleLLMProxy } from "./llm-proxy-handler";

test("nonstream media failures persist unknown usage instead of inventing zero counts", async ({
  makeAgent,
  makeUser,
  makeMember,
}) => {
  let calls = 0;
  const upstream = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      calls++;
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "17",
      });
      response.end(
        JSON.stringify({ error: { message: "Synthetic rate limit" } }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing upstream port");
  config.llm.azure.baseUrl = `http://127.0.0.1:${address.port}/openai/v1`;
  config.llmProxy.plugins = [];
  config.llmProxy.usageAccountingMode = "off";
  const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId);
  const token = await makePassthroughCredential({
    organizationId: agent.organizationId,
    ownerId: user.id,
  });
  const app = createFastifyInstance();
  app.post("/v1/azure/:agentId/images/generations", (request, reply) =>
    handleLLMProxy(
      Azure.API.ImageGenerationRequestSchema.parse(request.body),
      request,
      reply,
      { ...azureImagesAdapterFactory, unavailableUsageAccounting: true },
    ),
  );
  try {
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    const SDK = (await import(process.env.ARCHESTRA_AUDIO_JS_SDK ?? "openai"))
      .default as typeof OpenAI;
    const client = new SDK({
      baseURL: `${origin}/v1/azure/${agent.id}`,
      apiKey: "synthetic-provider-key",
      defaultHeaders: { "x-archestra-virtual-key": token },
      maxRetries: 0,
    });
    await expect(
      client.images.generate({ model: "image-alias", prompt: "Synthetic." }),
    ).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(1);
    const rows = await InteractionModel.getAllInteractionsForProfile(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cost: null,
      response: {
        __mediaUsage: { tokensAvailable: false, costAvailable: false },
      },
    });
  } finally {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
