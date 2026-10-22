import { spawn } from "node:child_process";
import Fastify from "fastify";
import OpenAI from "openai";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel, VirtualApiKeyModel } from "@/models";
import { expect, test } from "@/test";
import azureRoutes from "./azure";

test("round-trips image SDK parameters through the governed local route", async ({
  makeAgent,
  makeUser,
  makeMember,
  makeSecret,
  makeLlmProviderApiKey,
}) => {
  config.llm.azure.baseUrl = "";
  config.llmProxy.plugins = [];
  const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
  const user = await makeUser();
  await makeMember(user.id, agent.organizationId);
  const upstream = Fastify();
  const captured: Record<string, unknown>[] = [];
  upstream.post("/openai/v1/images/generations", async (request) => {
    expect(request.headers["api-key"]).toBe("synthetic-upstream-key");
    captured.push(request.body as Record<string, unknown>);
    return {
      created: 1,
      data: [{ b64_json: "aW1hZ2U=" }],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    };
  });
  const app = createFastifyInstance();
  try {
    const url = await upstream.listen({ port: 0, host: "127.0.0.1" });
    const secret = await makeSecret({
      secret: { apiKey: "synthetic-upstream-key" },
    });
    const key = await makeLlmProviderApiKey(agent.organizationId, secret.id, {
      provider: "azure",
      baseUrl: `${url}/openai/v1`,
    });
    const { value } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      authorId: user.id,
      name: "Synthetic SDK test",
      providerApiKeys: [{ provider: "azure", providerApiKeyId: key.id }],
    });
    await app.register(azureRoutes);
    const proxyUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    const sdk = new OpenAI({
      apiKey: value,
      baseURL: `${proxyUrl}/v1/azure/${agent.id}`,
      maxRetries: 0,
    });
    const body = {
      model: "art-production",
      prompt: "A blue circle",
      response_format: "b64_json" as const,
      style: "natural" as const,
    };
    const response = await sdk.images.generate(body);
    expect(response.data?.[0]?.b64_json).toBe("aW1hZ2U=");
    expect(captured.at(-1)).toMatchObject(body);
    // Optional external runner exercises freshly installed Python/JS releases
    // without changing the server's locked SDK or adding runtime dependencies.
    const runner = process.env.ARCHESTRA_TEST_CURRENT_SDK_RUNNER;
    if (runner) {
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [runner], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        let error = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          error += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve(output) : reject(new Error(error)),
        );
        child.stdin.end(
          JSON.stringify({
            baseURL: `${proxyUrl}/v1/azure/${agent.id}`,
            apiKey: value,
            body,
          }),
        );
      });
      expect(JSON.parse(result)).toMatchObject({
        clients: 2,
        rejectedUnsupported: 2,
      });
      expect(captured).toHaveLength(3);
      for (const request of captured) expect(request).toMatchObject(body);
    }
    await expect(
      sdk.images.generate({ ...body, stream: true }),
    ).rejects.toMatchObject({ status: 400 });
    const unauthorized = new OpenAI({
      apiKey: "invalid-key",
      baseURL: `${proxyUrl}/v1/azure/${agent.id}`,
      maxRetries: 0,
    });
    await expect(unauthorized.images.generate(body)).rejects.toMatchObject({
      status: 401,
    });
    await expect
      .poll(async () => {
        const interactions =
          await InteractionModel.getAllInteractionsForProfile(agent.id);
        return interactions.at(-1)?.type;
      })
      .toBe("azure:images");
  } finally {
    app.server.closeAllConnections();
    upstream.server.closeAllConnections();
    await app.close();
    await upstream.close();
  }
});
