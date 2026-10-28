import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import InteractionModel from "@/models/interaction";
import ModelModel from "@/models/model";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { accessGrants, expect, test } from "@/test";
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
            config.llmProxy.usageAccountingMode = withAgent ? "enforce" : "off";
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
            const promptTokens = 10 + reads + writes;
            const usage = {
              prompt_tokens: promptTokens,
              completion_tokens: 5,
              total_tokens: promptTokens + 5,
              prompt_tokens_details: {
                cached_tokens: reads,
                cache_write_tokens: writes,
              },
            };
            let sent: Record<string, unknown> | undefined;
            let calls = 0;
            const respond = async (request: Request) => {
              expect(request.url).toContain(origin);
              sent = (await request.json()) as Record<string, unknown>;
              calls++;
              if (provider === "bedrock") {
                const usage = {
                  inputTokens: 10,
                  outputTokens: 5,
                  totalTokens: promptTokens + 5,
                  cacheReadInputTokens: reads,
                  cacheWriteInputTokens: writes,
                };
                if (!stream)
                  return HttpResponse.json({
                    output: {
                      message: {
                        role: "assistant",
                        content: [{ text: "answer" }],
                      },
                    },
                    stopReason: "end_turn",
                    usage,
                  });
                const codec = new EventStreamCodec(toUtf8, fromUtf8);
                const events: Array<[string, unknown]> = [
                  ["messageStart", { role: "assistant" }],
                  [
                    "contentBlockDelta",
                    { contentBlockIndex: 0, delta: { text: "answer" } },
                  ],
                  ["contentBlockStop", { contentBlockIndex: 0 }],
                  ["messageStop", { stopReason: "end_turn" }],
                  ["metadata", { usage }],
                ];
                const parts = events.map(([type, body]) =>
                  codec.encode({
                    headers: {
                      ":event-type": { type: "string", value: type },
                      ":content-type": {
                        type: "string",
                        value: "application/json",
                      },
                      ":message-type": { type: "string", value: "event" },
                    },
                    body: fromUtf8(JSON.stringify(body)),
                  }),
                );
                const bytes = new Uint8Array(
                  parts.reduce((n, p) => n + p.length, 0),
                );
                let offset = 0;
                for (const part of parts) {
                  bytes.set(part, offset);
                  offset += part.length;
                }
                return new HttpResponse(bytes, {
                  headers: {
                    "content-type": "application/vnd.amazon.eventstream",
                  },
                });
              }
              if (provider === "anthropic") {
                const usage = {
                  input_tokens: 10,
                  output_tokens: 5,
                  cache_read_input_tokens: reads,
                  cache_creation_input_tokens: writes,
                };
                const message = {
                  id: "msg_cache",
                  type: "message",
                  role: "assistant",
                  model,
                  content: [{ type: "text", text: "answer" }],
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage,
                };
                if (!stream) return HttpResponse.json(message);
                const events = [
                  {
                    type: "message_start",
                    message: {
                      ...message,
                      content: [],
                      stop_reason: null,
                      usage: { ...usage, output_tokens: 0 },
                    },
                  },
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "answer" },
                  },
                  { type: "content_block_stop", index: 0 },
                  {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: 5 },
                  },
                  { type: "message_stop" },
                ];
                return new HttpResponse(
                  events
                    .map(
                      (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
                    )
                    .join(""),
                  { headers: { "content-type": "text/event-stream" } },
                );
              }
              if (provider === "gemini") {
                const message = {
                  candidates: [
                    {
                      content: { role: "model", parts: [{ text: "answer" }] },
                      finishReason: "STOP",
                      index: 0,
                    },
                  ],
                  usageMetadata: {
                    promptTokenCount: promptTokens,
                    candidatesTokenCount: 5,
                    totalTokenCount: promptTokens + 5,
                    cachedContentTokenCount: reads,
                  },
                  modelVersion: model,
                };
                return !stream
                  ? HttpResponse.json(message)
                  : new HttpResponse(`data: ${JSON.stringify(message)}\n\n`, {
                      headers: { "content-type": "text/event-stream" },
                    });
              }
              if (api === "responses") {
                const response = {
                  id: "resp_cache",
                  object: "response",
                  created_at: 1,
                  status: "completed",
                  model,
                  output: [
                    {
                      id: "msg_cache",
                      type: "message",
                      role: "assistant",
                      status: "completed",
                      content: [
                        {
                          type: "output_text",
                          text: "answer",
                          annotations: [],
                        },
                      ],
                    },
                  ],
                  usage: {
                    input_tokens: promptTokens,
                    output_tokens: 5,
                    total_tokens: promptTokens + 5,
                    input_tokens_details: {
                      cached_tokens: reads,
                      cache_write_tokens: writes,
                    },
                    output_tokens_details: { reasoning_tokens: 0 },
                  },
                };
                if (!stream) return HttpResponse.json(response);
                return new HttpResponse(
                  `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 0, response })}\n\n`,
                  { headers: { "content-type": "text/event-stream" } },
                );
              }
              const message = {
                id: "chatcmpl_cache",
                object: "chat.completion",
                created: 1,
                model,
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "answer" },
                    finish_reason: "stop",
                  },
                ],
                usage,
              };
              if (!stream) return HttpResponse.json(message);
              const chunks = [
                {
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "answer" },
                      finish_reason: "stop",
                    },
                  ],
                },
                { choices: [], usage },
              ];
              return new HttpResponse(
                `${chunks
                  .map(
                    (c) =>
                      `data: ${JSON.stringify({ ...message, object: "chat.completion.chunk", ...c })}\n\n`,
                  )
                  .join("")}data: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              );
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
