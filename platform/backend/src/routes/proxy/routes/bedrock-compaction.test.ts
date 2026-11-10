import { createServer, type Server } from "node:http";
import { createLLMModel } from "@/clients/llm-client";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import ModelModel from "@/models/model";
import {
  createCompactionSummarizer,
  summarizeCompactionTranscript,
} from "@/services/context-compaction";
import { afterEach, expect, test } from "@/test";
import bedrockProxyRoutes from "./bedrock";

let app: FastifyInstanceWithZod | undefined;
let upstream: Server | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await new Promise<void>((resolve, reject) => {
    if (!upstream) return resolve();
    upstream.close((error) => (error ? reject(error) : resolve()));
  });
  upstream = undefined;
});

// Keep the app, AI SDK, Bedrock client, proxy and retry real. Only the upstream
// provider is a fault-injection boundary; no live credentials or shared DB.
for (const source of ["chat:compaction", "a2a:compaction"] as const) {
  test(`${source} summarizes through the running proxy when Bedrock rejects temperature`, async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({ authorId: user.id });
    await makeMember(user.id, agent.organizationId, { role: "admin" });
    const modelName = "openai.test-summary";
    await ModelModel.upsert({
      externalId: `bedrock/${modelName}`,
      provider: "bedrock",
      modelId: modelName,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const requests: Array<Record<string, unknown>> = [];
    upstream = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push(payload);
      response.setHeader("content-type", "application/json");
      if (payload.inferenceConfig?.temperature !== undefined) {
        response.writeHead(400);
        response.end(
          JSON.stringify({
            message:
              "This model doesn't support the temperature field. Remove temperature and try again.",
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          output: {
            message: {
              role: "assistant",
              content: [
                { text: "<summary>Keep the migration plan.</summary>" },
              ],
            },
          },
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream?.listen(0, "127.0.0.1", resolve),
    );
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string")
      throw new Error("Missing upstream port");
    app = createFastifyInstance();
    await app.register(bedrockProxyRoutes);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing app port");
    config.api.port = address.port;
    const model = createLLMModel({
      provider: "bedrock",
      modelName,
      agentId: agent.id,
      userId: user.id,
      apiKey: "synthetic-bedrock-key",
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      source,
    });
    const summaryPromise =
      source === "chat:compaction"
        ? summarizeCompactionTranscript({
            model,
            prompt: "Summarize the migration plan.",
          })
        : createCompactionSummarizer({ model, salvageUntagged: true })({
            transcript: "[user]: Keep the migration plan.",
            previousSummary: null,
          });
    const summary = await summaryPromise;
    expect(summary).toBe("Keep the migration plan.");
    expect(requests).toHaveLength(2);
    expect(requests[0].inferenceConfig).toMatchObject({ temperature: 0 });
    expect(requests[1]).toEqual({
      ...requests[0],
      inferenceConfig: { maxTokens: 8192 },
    });
  });
}
