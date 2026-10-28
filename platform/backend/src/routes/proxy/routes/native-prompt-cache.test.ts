import { http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import InteractionModel from "@/models/interaction";
import ModelModel from "@/models/model";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { accessGrants, expect, test } from "@/test";
import { promptCacheUpstreamResponse } from "@/test/llm-prompt-cache-upstream";
import { useMswServer } from "@/test/msw";
import { drainBackgroundWork } from "@/utils/background-work";
import anthropicRoutes from "./anthropic";
import azureRoutes from "./azure";
import bedrockRoutes from "./bedrock";
import geminiRoutes from "./gemini";
import openaiRoutes from "./openai";

// Complements the all-provider tool matrix: real native routes and SDKs,
// HTTP boundary only, with both serialized usage and persisted billing checked.
// biome-ignore lint/correctness/useHookAtTopLevel: lifecycle helper
const server = useMswServer();
const providers = [
  "anthropic",
  "openai",
  "azure",
  "bedrock",
  "gemini",
] as const;
const routes = {
  anthropic: anthropicRoutes,
  openai: openaiRoutes,
  azure: azureRoutes,
  bedrock: bedrockRoutes,
  gemini: geminiRoutes,
};
const marker = { type: "ephemeral", ttl: "5m" };
const checkpoint = { cachePoint: { type: "default", ttl: "5m" } };
const tool = {
  name: "lookup",
  description: "Look up a record",
  parameters: { type: "object", properties: {} },
};

for (const provider of providers) {
  for (const api of provider === "openai" || provider === "azure"
    ? ["chat", "responses"]
    : ["native"]) {
    for (const stream of [false, true]) {
      for (const withAgent of [false, true]) {
        for (const cacheCase of [
          "mixed",
          "read-only",
          "write-only",
          "none",
        ] as const) {
          test(`${provider}/${api}: cache controls and billing survive native ${stream ? "stream" : "JSON"}, agent=${withAgent}, ${cacheCase}`, async ({
            makeOrganization,
            makeAgent,
            makeSecret,
            makeLlmProviderApiKey,
          }) => {
            const origin = `https://${provider}.cache.example.test${provider === "azure" ? "/openai/v1" : ""}`;
            config.llm[provider].baseUrl = origin;
            if (provider === "bedrock")
              config.llm.bedrock.iamAuthEnabled = false;
            const org = await makeOrganization();
            const agent = await makeAgent({
              organizationId: org.id,
              agentType: "agent",
            });
            const model =
              provider === "gemini"
                ? "gemini-2.5-pro"
                : provider === "anthropic"
                  ? "claude-sonnet-4-6"
                  : "cache-test";
            await ModelModel.create({
              externalId: `${provider}/${model}`,
              provider,
              modelId: model,
              inputModalities: ["text"],
              outputModalities: ["text"],
              customPricePerMillionInput: "1",
              customPricePerMillionOutput: "2",
              customPricePerMillionCacheRead: "0.1",
              customPricePerMillionCacheWrite: "1.25",
            });
            const secret = await makeSecret({
              secret: { apiKey: "test-cache-key" },
            });
            const key = await makeLlmProviderApiKey(org.id, secret.id, {
              provider,
              baseUrl: origin,
            });
            const virtual = await VirtualApiKeyModel.create({
              organizationId: org.id,
              name: "Cache test",
              ...accessGrants("org"),
              providerApiKeys: [{ provider, providerApiKeyId: key.id }],
            });
            const reads =
              cacheCase === "mixed" || cacheCase === "read-only" ? 100 : 0;
            const writes =
              provider !== "gemini" &&
              (cacheCase === "mixed" || cacheCase === "write-only")
                ? 40
                : 0;
            let sent: Record<string, unknown> | undefined;
            let calls = 0;
            const respond = async (request: Request) => {
              expect(request.url).toContain(origin);
              sent = (await request.json()) as Record<string, unknown>;
              calls++;
              return promptCacheUpstreamResponse({
                provider,
                api,
                model,
                stream,
                reads,
                writes,
              });
            };
            const upstreamPath =
              provider === "anthropic"
                ? "/v1/messages"
                : provider === "gemini"
                  ? "/v1beta/models/:model"
                  : provider === "bedrock"
                    ? `/model/${model}/converse`
                    : api === "responses"
                      ? "/responses"
                      : "/chat/completions";
            server.use(
              http.post(`${origin}${upstreamPath}`, ({ request }) =>
                respond(request),
              ),
            );
            // Avoid MSW cloning finite SSE streams, which can keep SDK readers open.
            if (stream)
              vi.stubGlobal(
                "fetch",
                (input: RequestInfo | URL, init?: RequestInit) =>
                  respond(new Request(input, init)),
              );
            const segment = withAgent ? `/${agent.id}` : "";
            let url = `/v1/${provider}${segment}/${api === "responses" ? "responses" : "chat/completions"}`;
            let payload: Record<string, unknown> = {
              model,
              stream,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "prefix",
                      prompt_cache_breakpoint: { mode: "explicit" },
                    },
                  ],
                },
              ],
              prompt_cache_key: "stable-prefix",
              prompt_cache_options: { mode: "explicit", ttl: "30m" },
              prompt_cache_retention: "in-memory",
              tools: [{ type: "function", function: tool }],
            };
            if (api === "responses") {
              payload = {
                model,
                stream,
                input: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: "prefix",
                        prompt_cache_breakpoint: { mode: "explicit" },
                      },
                    ],
                  },
                ],
                prompt_cache_key: "stable-prefix",
                prompt_cache_options: { mode: "explicit", ttl: "30m" },
                prompt_cache_retention: "in-memory",
              };
            }
            if (
              (provider === "openai" || provider === "azure") &&
              cacheCase === "write-only"
            ) {
              delete payload.prompt_cache_key;
              delete payload.prompt_cache_options;
              delete payload.prompt_cache_retention;
              if (api === "responses") payload.input = "question";
              else payload.messages = [{ role: "user", content: "question" }];
            }
            if (provider === "anthropic") {
              url = `/v1/anthropic${segment}/v1/messages`;
              payload = {
                model,
                stream,
                max_tokens: 32,
                cache_control: marker,
                system: [
                  { type: "text", text: "system", cache_control: marker },
                ],
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "prefix", cache_control: marker },
                    ],
                  },
                ],
                tools: [
                  {
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.parameters,
                    cache_control: marker,
                  },
                ],
              };
            } else if (provider === "bedrock") {
              url = `/v1/bedrock${segment}/${stream ? "converse-stream" : "converse"}`;
              payload = {
                modelId: model,
                system: [{ text: "system" }, checkpoint],
                messages: [
                  { role: "user", content: [{ text: "prefix" }, checkpoint] },
                ],
                toolConfig: {
                  tools: [
                    {
                      toolSpec: {
                        name: tool.name,
                        description: tool.description,
                        inputSchema: { json: tool.parameters },
                      },
                    },
                    checkpoint,
                  ],
                },
              };
            } else if (provider === "gemini") {
              url = `/v1/gemini${segment}/v1beta/models/${model}:${stream ? "streamGenerateContent" : "generateContent"}`;
              payload = {
                contents: [{ role: "user", parts: [{ text: "question" }] }],
                cachedContent: "cachedContents/reusable-prefix",
              };
            }
            const app = createFastifyInstance();
            await app.register(routes[provider]);
            try {
              const response = await app.inject({
                method: "POST",
                url,
                headers: {
                  authorization: `Bearer ${virtual.value}`,
                  ...(provider === "anthropic"
                    ? { "anthropic-version": "2023-06-01" }
                    : {}),
                },
                payload,
              });
              expect(response.statusCode, response.body).toBe(200);
              expect(calls).toBe(1);
              if (provider === "gemini")
                expect(sent?.cachedContent).toBe(payload.cachedContent);
              else if (provider === "bedrock") {
                expect(sent?.system).toEqual(payload.system);
                expect(sent?.messages).toEqual(payload.messages);
                expect(sent?.toolConfig).toEqual(payload.toolConfig);
              } else if (provider === "anthropic") {
                expect(sent?.cache_control).toEqual(marker);
                expect(sent?.system).toEqual(payload.system);
                expect(sent?.messages).toEqual(payload.messages);
                expect(sent?.tools).toEqual(payload.tools);
              } else {
                expect(sent?.prompt_cache_key).toBe(payload.prompt_cache_key);
                expect(sent?.prompt_cache_options).toEqual(
                  payload.prompt_cache_options,
                );
                expect(sent?.prompt_cache_retention).toBe(
                  payload.prompt_cache_retention,
                );
                if (api === "responses")
                  expect(sent?.input).toEqual(payload.input);
                else expect(sent?.messages).toEqual(payload.messages);
              }
              expect(response.body).toContain("answer");
              if (provider === "openai" || provider === "azure") {
                if (reads > 0)
                  expect(response.body).toContain(`"cached_tokens":${reads}`);
                if (writes > 0)
                  expect(response.body).toContain(
                    `"cache_write_tokens":${writes}`,
                  );
              }
              const readField =
                provider === "anthropic"
                  ? "cache_read_input_tokens"
                  : provider === "bedrock"
                    ? "cacheReadInputTokens"
                    : provider === "gemini"
                      ? "cachedContentTokenCount"
                      : "cached_tokens";
              const writeField =
                provider === "anthropic"
                  ? "cache_creation_input_tokens"
                  : provider === "bedrock"
                    ? "cacheWriteInputTokens"
                    : "cache_write_tokens";
              if (reads > 0)
                expect(response.body).toContain(`"${readField}":${reads}`);
              if (writes > 0)
                expect(response.body).toContain(`"${writeField}":${writes}`);
              await drainBackgroundWork();
              const logged = await InteractionModel.findAllPaginated({
                limit: 1,
                offset: 0,
              });
              expect(logged.data[0]).toMatchObject({
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: reads,
                cacheWriteTokens: writes,
              });
              expect(Number(logged.data[0].cost)).toBeCloseTo(
                (20 + reads * 0.1 + writes * 1.25) / 1_000_000,
                8,
              );
            } finally {
              await app.close();
            }
          });
        }
      }
    }
  }
}
