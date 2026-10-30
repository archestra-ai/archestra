import { http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import InteractionModel from "@/models/interaction";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { accessGrants, expect, test } from "@/test";
import { promptCacheUpstreamResponse } from "@/test/llm-prompt-cache-upstream";
import { useMswServer } from "@/test/msw";
import { drainBackgroundWork } from "@/utils/background-work";
import modelRouterRoutes from "./model-router";

// Complements the all-provider tool matrix: real router routes and SDKs,
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
const marker = { type: "ephemeral", ttl: "5m" };
const checkpoint = { cachePoint: { type: "default", ttl: "5m" } };
const tool = {
  name: "lookup",
  description: "Look up a record",
  parameters: { type: "object", properties: {} },
};

for (const provider of providers) {
  for (const api of ["chat", "responses"]) {
    for (const stream of [false, true]) {
      for (const withAgent of [false, true]) {
        for (const cacheCase of [
          "mixed",
          "read-only",
          "write-only",
          "none",
        ] as const) {
          test(`${provider}/${api}: cache controls and billing survive router ${stream ? "stream" : "JSON"}, agent=${withAgent}, ${cacheCase}`, async ({
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
                  : provider === "azure"
                    ? "gpt-4o"
                    : "cache-test";
            const storedModel = await ModelModel.create({
              externalId: `${provider}/${model}`,
              provider,
              modelId: model,
              inputModalities: ["text", "image"],
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
            await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
              storedModel.id,
            ]);
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
            const url = `/v1/model-router${segment}/${api === "responses" ? "responses" : "chat/completions"}`;
            const marked = provider === "anthropic" || provider === "bedrock";
            const textType = api === "responses" ? "input_text" : "text";
            const text = (value: string) => ({
              type: textType,
              text: value,
              ...(marked ? { cache_control: marker } : {}),
            });
            const messages =
              provider === "gemini"
                ? [{ role: "user", content: [text("question")] }]
                : [
                    { role: "system", content: [text("system")] },
                    { role: "user", content: [text("prefix")] },
                  ];
            const payload: Record<string, unknown> = {
              model: `${provider}:${model}`,
              stream,
              ...(stream && api === "chat"
                ? { stream_options: { include_usage: true } }
                : {}),
              ...(api === "responses" ? { input: messages } : { messages }),
              ...(provider === "gemini"
                ? { cachedContent: "cachedContents/reusable-prefix" }
                : {
                    tools: [
                      api === "responses"
                        ? {
                            type: "function",
                            ...tool,
                            ...(marked ? { cache_control: marker } : {}),
                          }
                        : {
                            type: "function",
                            function: tool,
                            ...(marked ? { cache_control: marker } : {}),
                          },
                    ],
                  }),
              ...(provider === "anthropic" ? { cache_control: marker } : {}),
              ...(!marked && provider !== "gemini"
                ? {
                    prompt_cache_key: "stable-prefix",
                    prompt_cache_options: { mode: "explicit", ttl: "30m" },
                  }
                : {}),
            };
            const app = createFastifyInstance();
            await app.register(modelRouterRoutes);
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
                expect(sent?.cachedContent).toBe(
                  "cachedContents/reusable-prefix",
                );
              else if (provider === "bedrock") {
                expect(sent?.system).toEqual([{ text: "system" }, checkpoint]);
                expect(sent?.messages).toEqual([
                  { role: "user", content: [{ text: "prefix" }, checkpoint] },
                ]);
                expect(sent?.toolConfig).toEqual({
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
                });
              } else if (provider === "anthropic") {
                expect(sent?.cache_control).toEqual(marker);
                expect(sent?.system).toEqual([
                  { type: "text", text: "system", cache_control: marker },
                ]);
                expect(sent?.messages).toEqual([
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "prefix", cache_control: marker },
                    ],
                  },
                ]);
                expect(sent?.tools).toEqual([
                  {
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.parameters,
                    cache_control: marker,
                  },
                ]);
              } else {
                expect(sent?.prompt_cache_key).toBe("stable-prefix");
                expect(sent?.prompt_cache_options).toEqual(
                  payload.prompt_cache_options,
                );
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
              if (reads > 0)
                expect(response.body).toContain(`"cached_tokens":${reads}`);
              if (writes > 0)
                expect(response.body).toContain(
                  `"cache_write_tokens":${writes}`,
                );
              if (
                provider === "anthropic" &&
                api === "chat" &&
                withAgent &&
                cacheCase === "mixed"
              ) {
                const invalidMessages = [
                  [{ role: "user", content: "", cache_control: marker }],
                  [
                    {
                      role: "user",
                      content: [
                        {
                          type: "input_audio",
                          input_audio: { data: "YQ==", format: "wav" },
                          cache_control: marker,
                        },
                      ],
                    },
                  ],
                  [
                    {
                      role: "user",
                      content: [
                        {
                          type: "text",
                          text: "prefix",
                          cache_control: { ...marker, ttl: "1h" },
                        },
                      ],
                      cache_control: marker,
                    },
                  ],
                ];
                for (const messages of invalidMessages) {
                  const invalid = await app.inject({
                    method: "POST",
                    url,
                    headers: { authorization: `Bearer ${virtual.value}` },
                    payload: { ...payload, messages },
                  });
                  expect(invalid.statusCode, invalid.body).toBe(400);
                  expect(invalid.body).toContain("cache_control");
                }
                expect(calls).toBe(1);
              }
              if (
                withAgent &&
                cacheCase === "mixed" &&
                (provider === "anthropic" ||
                  provider === "bedrock" ||
                  provider === "gemini")
              ) {
                const cases: Array<{
                  field: string;
                  changes: Record<string, unknown>;
                }> = [
                  {
                    field: "prompt_cache_key",
                    changes: { prompt_cache_key: "unsupported-prefix" },
                  },
                  {
                    field: "prompt_cache_options",
                    changes: { prompt_cache_options: { mode: "explicit" } },
                  },
                  {
                    field: "prompt_cache_retention",
                    changes: { prompt_cache_retention: "24h" },
                  },
                ];
                if (provider !== "gemini")
                  cases.push({
                    field: "cachedContent",
                    changes: { cachedContent: "cachedContents/wrong-provider" },
                  });
                if (provider !== "anthropic")
                  cases.push({
                    field: "cache_control",
                    changes: { cache_control: marker },
                  });
                if (provider === "gemini") {
                  for (const location of ["message", "part", "tool"]) {
                    cases.push({
                      field: "cache_control",
                      changes:
                        location === "tool"
                          ? {
                              tools: [
                                api === "responses"
                                  ? {
                                      type: "function",
                                      ...tool,
                                      cache_control: marker,
                                    }
                                  : {
                                      type: "function",
                                      function: tool,
                                      cache_control: marker,
                                    },
                              ],
                            }
                          : {
                              [api === "responses" ? "input" : "messages"]: [
                                {
                                  role: "user",
                                  ...(location === "message"
                                    ? { cache_control: marker }
                                    : {}),
                                  content: [
                                    {
                                      type: textType,
                                      text: "prefix",
                                      ...(location === "part"
                                        ? { cache_control: marker }
                                        : {}),
                                    },
                                  ],
                                },
                              ],
                            },
                    });
                  }
                }
                cases.push({
                  field: "prompt_cache_breakpoint",
                  changes: {
                    [api === "responses" ? "input" : "messages"]: [
                      {
                        role: "user",
                        content: [
                          {
                            type: textType,
                            text: "prefix",
                            prompt_cache_breakpoint: { mode: "explicit" },
                          },
                        ],
                      },
                    ],
                  },
                });
                if (provider === "bedrock" && api === "chat")
                  cases.push({
                    field: "cache_control",
                    changes: {
                      tools: [
                        {
                          type: "function",
                          cache_control: marker,
                          function: {
                            ...tool,
                            cache_control: { type: "ephemeral", ttl: "1h" },
                          },
                        },
                      ],
                    },
                  });
                if (api === "responses") {
                  const field =
                    provider === "gemini"
                      ? "cache_control"
                      : "prompt_cache_breakpoint";
                  cases.push({
                    field,
                    changes: {
                      input: [
                        {
                          type: "function_call",
                          call_id: "call_cache",
                          name: tool.name,
                          arguments: "{}",
                        },
                        {
                          type: "function_call_output",
                          call_id: "call_cache",
                          output: [
                            {
                              type: "input_text",
                              text: "result",
                              [field]:
                                provider === "gemini"
                                  ? marker
                                  : { mode: "explicit" },
                            },
                          ],
                        },
                      ],
                    },
                  });
                }
                for (const { field, changes } of cases) {
                  const invalid = await app.inject({
                    method: "POST",
                    url,
                    headers: { authorization: `Bearer ${virtual.value}` },
                    payload: { ...payload, ...changes },
                  });
                  expect(invalid.statusCode, invalid.body).toBe(400);
                  expect(invalid.body).toContain(field);
                }
                expect(calls).toBe(1);
              }
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
