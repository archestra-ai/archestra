import { createServer, type Server } from "node:http";
import { createLLMModel } from "@/clients/llm-client";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import ModelModel from "@/models/model";
import { createCompactionSummarizer } from "@/services/context-compaction";
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

type Source = "chat:compaction" | "a2a:compaction";
type UpstreamReply = { status: number; body: Record<string, unknown> };

// Keep the app, AI SDK, Bedrock client, proxy and retry real. Only the upstream
// provider is a fault-injection boundary; no live credentials or shared DB.
async function summarizeThroughProxy(params: {
  agentId: string;
  userId: string;
  source: Source;
  reply: (payload: Record<string, unknown>) => UpstreamReply;
}) {
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
    const { status, body: replyBody } = params.reply(payload);
    response.setHeader("content-type", "application/json");
    response.writeHead(status);
    response.end(JSON.stringify(replyBody));
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
    agentId: params.agentId,
    userId: params.userId,
    apiKey: "synthetic-bedrock-key",
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    source: params.source,
  });
  const summary = await createCompactionSummarizer({
    model,
    salvageUntagged: params.source !== "chat:compaction",
  })({
    transcript: "[user]: Keep the migration plan.",
    previousSummary: null,
  });
  return { summary, requests };
}

function converseReply(text: string, stopReason = "end_turn"): UpstreamReply {
  return {
    status: 200,
    body: {
      output: { message: { role: "assistant", content: [{ text }] } },
      stopReason,
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    },
  };
}

for (const source of ["chat:compaction", "a2a:compaction"] as const) {
  test(`${source} summarizes through the running proxy when Bedrock rejects temperature`, async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent({ authorId: user.id });
    await makeMember(user.id, agent.organizationId, { role: "admin" });

    const { summary, requests } = await summarizeThroughProxy({
      agentId: agent.id,
      userId: user.id,
      source,
      reply: (payload) =>
        (payload.inferenceConfig as { temperature?: number } | undefined)
          ?.temperature !== undefined
          ? {
              status: 400,
              body: {
                message:
                  "This model doesn't support the temperature field. Remove temperature and try again.",
              },
            }
          : converseReply("<summary>Keep the migration plan.</summary>"),
    });

    expect(summary).toBe("Keep the migration plan.");
    expect(requests).toHaveLength(2);
    expect(requests[0].inferenceConfig).toMatchObject({ temperature: 0 });
    expect(requests[1]).toEqual({
      ...requests[0],
      inferenceConfig: { maxTokens: 8192 },
    });
  });
}

test("a2a:compaction rejects an untagged reply cut at the output cap", async ({
  makeAgent,
  makeUser,
  makeMember,
}) => {
  const user = await makeUser();
  const agent = await makeAgent({ authorId: user.id });
  await makeMember(user.id, agent.organizationId, { role: "admin" });

  const { summary } = await summarizeThroughProxy({
    agentId: agent.id,
    userId: user.id,
    source: "a2a:compaction",
    reply: () => converseReply("Partial checkpoint of the migr", "max_tokens"),
  });

  expect(summary).toBeNull();
});
