import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import InteractionModel from "@/models/interaction";
import ModelModel from "@/models/model";
import ModelPoolModel from "@/models/model-pool";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { accessGrants, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { promptCacheUpstreamResponse } from "@/test/llm-prompt-cache-upstream";
import { useMswServer } from "@/test/msw";
import { drainBackgroundWork } from "@/utils/background-work";
import routes from "./model-router";

setupTestCacheManager();
// biome-ignore lint/correctness/useHookAtTopLevel: lifecycle helper
const server = useMswServer();

for (const stream of [false, true]) {
  for (const failover of [false, true]) {
    for (const ttl of ["5m", "1h"] as const) {
      test(`pool cache usage stays disjoint across failover=${failover}, stream=${stream}, ttl=${ttl}`, async ({
        makeOrganization,
        makeAgent,
        makeSecret,
        makeLlmProviderApiKey,
      }) => {
        config.llmProxy.modelPoolsEnabled = true;
        const org = await makeOrganization();
        const agent = await makeAgent({
          organizationId: org.id,
          agentType: "agent",
        });
        const keys = [];
        for (const name of ["primary", "fallback"]) {
          const modelId = `claude-cache-${name}`;
          await ModelModel.create({
            externalId: `anthropic/${modelId}`,
            provider: "anthropic",
            modelId,
            inputModalities: ["text"],
            outputModalities: ["text"],
            customPricePerMillionInput: "1",
            customPricePerMillionOutput: "2",
            customPricePerMillionCacheRead: "0.1",
            customPricePerMillionCacheWrite: "1.25",
          });
          const secret = await makeSecret({
            secret: { apiKey: `test-${name}` },
          });
          keys.push(
            await makeLlmProviderApiKey(org.id, secret.id, {
              provider: "anthropic",
              baseUrl: `https://${name}.cache-pool.example.test`,
            }),
          );
        }
        const virtual = await VirtualApiKeyModel.create({
          organizationId: org.id,
          name: "Cache pool",
          ...accessGrants("org"),
          providerApiKeys: [
            { provider: "anthropic", providerApiKeyId: keys[0].id },
          ],
        });
        const pool = await ModelPoolModel.create({
          organizationId: org.id,
          input: {
            name: "cache-pool",
            members: keys.map((key, i) => ({
              providerApiKeyId: key.id,
              modelId: `claude-cache-${i === 0 ? "primary" : "fallback"}`,
              priority: i + 1,
              weight: 1,
              enabled: true,
            })),
          },
        });
        await ModelPoolModel.setPoolsForVirtualApiKey({
          organizationId: org.id,
          virtualApiKeyId: virtual.virtualKey.id,
          poolIds: [pool.id],
        });
        const reads = failover ? 0 : 100;
        const writes = 40;
        const oneHourWrites = ttl === "1h" ? writes : 0;
        const calls: string[] = [];
        const marker = { type: "ephemeral", ttl };
        const respond = async (request: Request) => {
          const name = new URL(request.url).hostname.startsWith("primary")
            ? "primary"
            : "fallback";
          expect(request.url).toBe(
            `https://${name}.cache-pool.example.test/v1/messages`,
          );
          const body = (await request.json()) as {
            model: string;
            messages: unknown[];
          };
          expect(body.model).toBe(`claude-cache-${name}`);
          expect(body.messages).toEqual([
            {
              role: "user",
              content: [
                { type: "text", text: "prefix", cache_control: marker },
              ],
            },
          ]);
          calls.push(name);
          if (name === "primary" && failover)
            return HttpResponse.json(
              {
                type: "error",
                error: { type: "overloaded_error", message: "busy" },
              },
              { status: 503 },
            );
          return promptCacheUpstreamResponse({
            provider: "anthropic",
            api: "chat",
            model: body.model,
            stream,
            reads,
            writes,
            oneHourWrites,
          });
        };
        for (const name of ["primary", "fallback"])
          server.use(
            http.post(
              `https://${name}.cache-pool.example.test/v1/messages`,
              ({ request }) => respond(request),
            ),
          );
        if (stream)
          vi.stubGlobal(
            "fetch",
            (input: RequestInfo | URL, init?: RequestInit) =>
              respond(new Request(input, init)),
          );
        const app = createFastifyInstance();
        await app.register(routes);
        try {
          const response = await app.inject({
            method: "POST",
            url: `/v1/model-router/${agent.id}/chat/completions`,
            headers: { authorization: `Bearer ${virtual.value}` },
            payload: {
              model: "cache-pool",
              stream,
              stream_options: { include_usage: true },
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "prefix", cache_control: marker },
                  ],
                },
              ],
            },
          });
          expect(response.statusCode, response.body).toBe(200);
          expect(calls).toEqual(
            failover ? ["primary", "fallback"] : ["primary"],
          );
          expect(response.body).toContain('"cache_write_tokens":40');
          expect(response.body).toContain(`"cached_tokens":${reads}`);
          if (oneHourWrites > 0)
            expect(response.body).toContain('"cache_write_1h_tokens":40');
          await drainBackgroundWork();
          const logged = await InteractionModel.findAllPaginated({
            limit: 1,
            offset: 0,
          });
          expect(logged.data[0]).toMatchObject({
            model: `claude-cache-${failover ? "fallback" : "primary"}`,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: reads,
            cacheWriteTokens: writes,
            cacheWrite1hTokens: oneHourWrites > 0 ? oneHourWrites : null,
          });
          expect(Number(logged.data[0].cost)).toBeCloseTo(
            (20 + reads * 0.1 + writes * 1.25 + oneHourWrites * 0.75) /
              1_000_000,
            8,
          );
        } finally {
          await app.close();
        }
      });
    }
  }
}
