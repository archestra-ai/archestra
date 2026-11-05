import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MODEL_POOL_ID_HEADER } from "@archestra/shared/consts";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { HttpResponse, http, passthrough } from "msw";
import { onTestFinished, vi } from "vitest";
import { internalCallHeader } from "@/clients/internal-call";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelModel, ModelPoolModel, VirtualApiKeyModel } from "@/models";
import InteractionBillingModel from "@/models/interaction-billing";
import { accessGrants, beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import type { Gemini } from "@/types";
import anthropicRoutes from "./anthropic";
import azureRoutes from "./azure";
import geminiRoutes from "./gemini";
import groqRoutes from "./groq";
import mistralRoutes from "./mistral";
import modelRouterRoutes from "./model-router";
import openaiRoutes from "./openai";
import openrouterRoutes from "./openrouter";
import xaiRoutes from "./xai";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper
const server = useMswServer();
setupTestCacheManager();
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
  config.llm.gemini.vertexAi.enabled = false;
});
const origin = "https://gemini.pool.test";
const usageMetadata = {
  promptTokenCount: 20,
  candidatesTokenCount: 3,
  thoughtsTokenCount: 2,
  cachedContentTokenCount: 4,
  totalTokenCount: 25,
};
function answer(
  parts: unknown[] = [
    { thought: true, text: "hidden reasoning" },
    { text: "pool " },
    { text: "answer" },
  ],
) {
  return {
    candidates: [
      { index: 0, content: { role: "model", parts }, finishReason: "STOP" },
    ],
    modelVersion: "gemini-3.1-flash-lite",
    responseId: "gemini-pool-response",
    usageMetadata,
  };
}
function sse(chunks: unknown[]) {
  return new HttpResponse(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}
const poolTest = test.extend<{
  pool: {
    app: ReturnType<typeof createFastifyInstance>;
    agentId: string;
    organizationId: string;
    keyId: string;
    token: string;
    poolId: string;
    ask: (
      extra?: Record<string, unknown>,
      wire?:
        | "openai"
        | "anthropic"
        | "azure"
        | "openrouter"
        | "groq"
        | "mistral"
        | "xai",
    ) => Promise<LightMyRequestResponse>;
  };
}>({
  pool: async (
    { makeOrganization, makeAgent, makeSecret, makeLlmProviderApiKey },
    use,
  ) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const key = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "selected-gemini-key" } })).id,
      { provider: "gemini", baseUrl: origin },
    );
    const anchor = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret({ secret: { apiKey: "anchor-must-not-leak" } })).id,
      { provider: "openai" },
    );
    const virtual = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Pool client",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "openai", providerApiKeyId: anchor.id }],
    });
    await ModelModel.create({
      provider: "gemini",
      modelId: "gemini-3.1-flash-lite",
      externalId: "gemini/gemini-3.1-flash-lite",
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: "1",
      customPricePerMillionOutput: "2",
      customPricePerMillionCacheRead: "0.5",
    });
    const created = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "gemini-pool",
        members: ["gemini-3.1-flash-lite", "gemini-2.5-flash"].map(
          (modelId, index) => ({
            providerApiKeyId: key.id,
            modelId,
            priority: index + 1,
            weight: 1,
            enabled: true,
          }),
        ),
      },
    });
    await ModelPoolModel.setPoolsForVirtualApiKey({
      organizationId: org.id,
      virtualApiKeyId: virtual.virtualKey.id,
      poolIds: [created.id],
    });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    await app.register(openaiRoutes);
    await app.register(geminiRoutes);
    await app.register(anthropicRoutes);
    await app.register(azureRoutes);
    await app.register(openrouterRoutes);
    await app.register(groqRoutes);
    await app.register(mistralRoutes);
    await app.register(xaiRoutes);
    const ask = (
      extra: Record<string, unknown> = {},
      wire:
        | "openai"
        | "anthropic"
        | "azure"
        | "openrouter"
        | "groq"
        | "mistral"
        | "xai" = "openai",
    ) =>
      app.inject({
        method: "POST",
        url:
          wire === "openai"
            ? `/v1/model-router/${agent.id}/chat/completions`
            : wire === "anthropic"
              ? `/v1/anthropic/${agent.id}/v1/messages`
              : `/v1/${wire}/${agent.id}/chat/completions`,
        headers: {
          authorization: `Bearer ${virtual.value}`,
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "gemini-pool",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
          ...extra,
        },
      });
    try {
      await use({
        app,
        agentId: agent.id,
        organizationId: org.id,
        keyId: key.id,
        token: virtual.value,
        poolId: created.id,
        ask,
      });
    } finally {
      await app.close();
    }
  },
});

for (const wire of ["openai", "anthropic"] as const) {
  for (const stream of [false, true]) {
    poolTest(
      `answers ${wire} through the selected Gemini key and model (stream=${stream})`,
      async ({ pool }) => {
        const hits: string[] = [];
        server.use(
          http.post(
            `${origin}/v1beta/models/:model`,
            async ({ request, params }) => {
              hits.push(String(params.model));
              expect(request.headers.get("x-goog-api-key")).toBe(
                "selected-gemini-key",
              );
              expect(request.headers.get("authorization")).toBeNull();
              expect(await request.json()).toMatchObject({
                contents: [{ role: "user", parts: [{ text: "hello" }] }],
                generationConfig: { maxOutputTokens: 32 },
              });
              return stream ? sse([answer()]) : HttpResponse.json(answer());
            },
          ),
        );
        const response = await pool.ask({ stream }, wire);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).not.toContain("hidden reasoning");
        if (stream) {
          expect(response.body).toContain("pool ");
          expect(response.body).toContain("answer");
        } else expect(response.body).toContain("pool answer");
        expect(response.headers["x-archestra-provider-key"]).toBe(pool.keyId);
        expect(hits).toEqual([
          `gemini-3.1-flash-lite:${stream ? "streamGenerateContent" : "generateContent"}`,
        ]);
        if (stream)
          expect(response.body).toContain(
            wire === "openai" ? "[DONE]" : "event: message_stop",
          );
        else if (wire === "openai")
          expect(response.json()).toMatchObject({
            model: "gemini-pool",
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
              prompt_tokens_details: { cached_tokens: 4 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
          });
        const rows = await db
          .select()
          .from(schema.interactionsTable)
          .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          type:
            wire === "openai" ? "openai:chatCompletions" : "anthropic:messages",
          model: "gemini-3.1-flash-lite",
          providerApiKeyId: pool.keyId,
          inputTokens: 16,
          outputTokens: 5,
          cacheReadTokens: 4,
          cost: "0.0000280000",
          attemptOutcome: "answered",
        });
      },
    );
  }
}

poolTest(
  "uses Google's 429 to fail over to the next model and cool down the first",
  async ({ pool }) => {
    const hits: string[] = [];
    server.use(
      http.post(`${origin}/v1beta/models/:model`, ({ params }) => {
        const model = String(params.model);
        hits.push(model);
        if (model.startsWith("gemini-3.1-flash-lite:"))
          return HttpResponse.json(
            {
              error: {
                code: 429,
                status: "RESOURCE_EXHAUSTED",
                message: "Quota exhausted",
              },
            },
            { status: 429 },
          );
        return HttpResponse.json(answer());
      }),
    );
    const first = await pool.ask();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers["x-archestra-attempts"]).toBe("2");
    const second = await pool.ask();
    expect(second.statusCode, second.body).toBe(200);
    expect(second.headers["x-archestra-attempts"]).toBe("1");
    expect(hits).toEqual([
      "gemini-3.1-flash-lite:generateContent",
      "gemini-2.5-flash:generateContent",
      "gemini-2.5-flash:generateContent",
    ]);
    const rows = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.attemptOutcome, "failed_over"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "gemini-3.1-flash-lite",
      inputTokens: 0,
      cost: "0.0000000000",
    });
  },
);

for (const stream of [false, true]) {
  poolTest(
    `falls back Gemini → Gemini → Haiku on 429 before output (stream=${stream})`,
    async ({ pool, makeSecret, makeLlmProviderApiKey }) => {
      const haiku = await makeLlmProviderApiKey(
        pool.organizationId,
        (await makeSecret({ secret: { apiKey: "selected-haiku-key" } })).id,
        { provider: "anthropic", baseUrl: "https://haiku.pool.test" },
      );
      await ModelPoolModel.update({
        organizationId: pool.organizationId,
        id: pool.poolId,
        input: {
          name: "gemini-pool",
          members: [
            {
              providerApiKeyId: pool.keyId,
              modelId: "gemini-3.1-flash-lite",
              priority: 1,
              weight: 1,
              enabled: true,
            },
            {
              providerApiKeyId: pool.keyId,
              modelId: "gemini-2.5-flash",
              priority: 2,
              weight: 1,
              enabled: true,
            },
            {
              providerApiKeyId: haiku.id,
              modelId: "claude-haiku-4-5",
              priority: 3,
              weight: 1,
              enabled: true,
            },
          ],
        },
      });
      const hits: string[] = [];
      server.use(
        http.post(`${origin}/v1beta/models/:model`, ({ params }) => {
          hits.push(String(params.model));
          return HttpResponse.json(
            {
              error: {
                code: 429,
                status: "RESOURCE_EXHAUSTED",
                message: "Quota exhausted",
              },
            },
            { status: 429 },
          );
        }),
        http.post(
          "https://haiku.pool.test/v1/messages",
          async ({ request }) => {
            const body = (await request.json()) as { model: string };
            hits.push(body.model);
            expect(request.headers.get("x-api-key")).toBe("selected-haiku-key");
            const message = {
              id: "msg-haiku",
              type: "message",
              role: "assistant",
              model: body.model,
              content: [{ type: "text", text: "fallback answer" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 2 },
            };
            if (!stream) return HttpResponse.json(message);
            return new HttpResponse(
              [
                [
                  "message_start",
                  {
                    type: "message_start",
                    message: { ...message, content: [], stop_reason: null },
                  },
                ],
                [
                  "content_block_start",
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  },
                ],
                [
                  "content_block_delta",
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "fallback answer" },
                  },
                ],
                [
                  "content_block_stop",
                  { type: "content_block_stop", index: 0 },
                ],
                [
                  "message_delta",
                  {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: 2 },
                  },
                ],
                ["message_stop", { type: "message_stop" }],
              ]
                .map(
                  ([event, data]) =>
                    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                )
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );
      const response = await pool.ask({ stream });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("fallback answer");
      expect(response.headers["x-archestra-provider-key"]).toBe(haiku.id);
      expect(hits).toEqual([
        `gemini-3.1-flash-lite:${stream ? "streamGenerateContent" : "generateContent"}`,
        `gemini-2.5-flash:${stream ? "streamGenerateContent" : "generateContent"}`,
        "claude-haiku-4-5",
      ]);
    },
  );
}

for (const wire of [
  "openai",
  "azure",
  "openrouter",
  "groq",
  "mistral",
  "xai",
] as const) {
  for (const stream of [false, true]) {
    poolTest(
      `roundtrips signed tool calls through the existing Gemini translator (${wire}, stream=${stream})`,
      async ({ pool }) => {
        const bodies: unknown[] = [];
        server.use(
          http.post(`${origin}/v1beta/models/:model`, async ({ request }) => {
            bodies.push(await request.json());
            const result =
              bodies.length === 1
                ? answer([
                    {
                      functionCall: { name: "read_value", args: { key: "a" } },
                      thoughtSignature: "synthetic-signature",
                    },
                  ])
                : answer();
            return stream ? sse([result]) : HttpResponse.json(result);
          }),
        );
        const tools = [
          {
            type: "function",
            function: {
              name: "read_value",
              description: "Read a synthetic value",
              parameters: {
                type: "object",
                properties: { key: { type: "string" } },
                required: ["key"],
              },
            },
          },
        ];
        const first = await pool.ask({ stream, tools }, wire);
        expect(first.statusCode, first.body).toBe(200);
        const chunks = stream
          ? first.body
              .split("\n\n")
              .filter((line) => line.startsWith("data: {"))
              .map((line) => JSON.parse(line.slice(6)))
          : [];
        const call = stream
          ? chunks.flatMap(
              (chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? [],
            )[0]
          : first.json().choices[0].message.tool_calls[0];
        expect(call.id).toMatch(/^gemsig-/);
        expect(call).toMatchObject({
          function: { name: "read_value", arguments: '{"key":"a"}' },
        });
        expect(first.body).toContain('"finish_reason":"tool_calls"');
        const second = await pool.ask(
          {
            stream,
            tools,
            messages: [
              { role: "user", content: "hello" },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: call.id, type: "function", function: call.function },
                ],
              },
              { role: "tool", tool_call_id: call.id, content: '{"value":1}' },
            ],
          },
          wire,
        );
        expect(second.statusCode, second.body).toBe(200);
        expect(bodies[1]).toMatchObject({
          contents: [
            { role: "user" },
            {
              role: "model",
              parts: [
                {
                  functionCall: { name: "read_value", args: { key: "a" } },
                  thoughtSignature: "synthetic-signature",
                },
              ],
            },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    name: "read_value",
                    response: { content: '{"value":1}' },
                  },
                },
              ],
            },
          ],
        });
      },
    );
  }
}

poolTest(
  "roundtrips signed tool calls on the Anthropic wire",
  async ({ pool }) => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${origin}/v1beta/models/:model`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          bodies.length === 1
            ? answer([
                {
                  functionCall: { name: "read_value", args: { key: "a" } },
                  thoughtSignature: "synthetic-signature",
                },
              ])
            : answer(),
        );
      }),
    );
    const tools = [
      {
        name: "read_value",
        description: "Read a synthetic value",
        input_schema: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
      },
    ];
    const first = await pool.ask({ tools }, "anthropic");
    expect(first.statusCode, first.body).toBe(200);
    const call = first
      .json()
      .content.find((block: { type: string }) => block.type === "tool_use");
    expect(call.id).toMatch(/^gemsig-/);
    const second = await pool.ask(
      {
        tools,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [call] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call.id,
                content: '{"value":1}',
              },
            ],
          },
        ],
      },
      "anthropic",
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(bodies[1]).toMatchObject({
      contents: [
        { role: "user" },
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "read_value", args: { key: "a" } },
              thoughtSignature: "synthetic-signature",
            },
          ],
        },
        { role: "user", parts: [{ functionResponse: { name: "read_value" } }] },
      ],
    });
  },
);

for (const wire of ["openai", "anthropic"] as const) {
  poolTest(
    `returns a prompt-blocked ${wire} stream without trying a sibling`,
    async ({ pool }) => {
      let hits = 0;
      server.use(
        http.post(`${origin}/v1beta/models/:model`, () => {
          hits++;
          return sse([
            {
              promptFeedback: { blockReason: "SAFETY" },
              usageMetadata: { promptTokenCount: 6, totalTokenCount: 6 },
            },
          ]);
        }),
      );
      const response = await pool.ask({ stream: true }, wire);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain(
        wire === "openai"
          ? '"finish_reason":"content_filter"'
          : '"stop_reason":"refusal"',
      );
      expect(hits).toBe(1);
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        inputTokens: 6,
        outputTokens: 0,
        providerApiKeyId: pool.keyId,
        attemptOutcome: "answered",
      });
    },
  );
  for (const stream of [false, true]) {
    poolTest(
      `does not replay the last Gemini member after a truncated quota error (${wire}, stream=${stream})`,
      async ({ pool }) => {
        const hits: string[] = [];
        const upstream = createServer((request, response) => {
          request.resume();
          request.on("end", () => {
            hits.push(request.url ?? "");
            if (request.url?.includes("gemini-3.1-flash-lite")) {
              response.writeHead(429, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  error: {
                    code: 429,
                    status: "RESOURCE_EXHAUSTED",
                    message: "Quota exhausted",
                  },
                }),
              );
              return;
            }
            response.writeHead(429, {
              "content-type": "application/json",
              "content-length": "1000",
            });
            response.write('{"error":{"message":"partial');
            setTimeout(() => response.destroy(), 30);
          });
        });
        await new Promise<void>((resolve) =>
          upstream.listen(0, "127.0.0.1", resolve),
        );
        onTestFinished(
          () =>
            new Promise<void>((resolve, reject) =>
              upstream.close((error) => (error ? reject(error) : resolve())),
            ),
        );
        const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
        server.use(
          http.post(`${baseUrl}/v1beta/models/:model`, () => passthrough()),
        );
        await db
          .update(schema.llmProviderApiKeysTable)
          .set({ baseUrl })
          .where(eq(schema.llmProviderApiKeysTable.id, pool.keyId));
        const response = await pool.ask({ stream }, wire);
        expect(response.statusCode, response.body).toBe(502);
        expect(hits).toHaveLength(2);
        expect(hits[0]).toContain("gemini-3.1-flash-lite");
        expect(hits[1]).toContain("gemini-2.5-flash");
      },
    );
  }
}

for (const stream of [false, true]) {
  poolTest(
    `aborts a timed-out in-flight Gemini member and completes fallback (stream=${stream})`,
    async ({ pool }) => {
      const hits: string[] = [];
      let slowRequestClosed = false;
      let closedBeforeFallbackAnswered = false;
      const upstream = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          hits.push(request.url ?? "");
          response.writeHead(200, {
            "content-type": stream ? "text/event-stream" : "application/json",
          });
          if (request.url?.includes("gemini-3.1-flash-lite")) {
            response.on("close", () => {
              slowRequestClosed = !response.writableEnded;
            });
            // Establish body I/O without producing a model response. SDK 1.45's
            // early-abort race before headers is outside this regression.
            response.write(stream ? ": accepted\n\n" : '{"candidates":[');
            return;
          }
          closedBeforeFallbackAnswered = slowRequestClosed;
          response.end(
            stream
              ? `data: ${JSON.stringify(answer())}\n\n`
              : JSON.stringify(answer()),
          );
        });
      });
      onTestFinished(async () => {
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
      server.use(
        http.post(`${baseUrl}/v1beta/models/:model`, () => passthrough()),
      );
      await db
        .update(schema.llmProviderApiKeysTable)
        .set({ baseUrl })
        .where(eq(schema.llmProviderApiKeysTable.id, pool.keyId));
      await ModelPoolModel.update({
        organizationId: pool.organizationId,
        id: pool.poolId,
        input: {
          name: "gemini-pool",
          streamTimeoutSeconds: 1,
          timeoutSeconds: 1,
          members: ["gemini-3.1-flash-lite", "gemini-2.5-flash"].map(
            (modelId, index) => ({
              providerApiKeyId: pool.keyId,
              modelId,
              priority: index + 1,
              weight: 1,
              enabled: true,
            }),
          ),
        },
      });
      const response = await pool.ask({ stream });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("answer");
      expect(hits).toHaveLength(2);
      expect(hits[0]).toContain("gemini-3.1-flash-lite");
      expect(hits[1]).toContain("gemini-2.5-flash");
      expect(slowRequestClosed).toBe(true);
      expect(closedBeforeFallbackAnswered).toBe(true);
    },
  );
}

poolTest(
  "does not retry another member after output from an incomplete stream",
  async ({ pool }) => {
    const hits: string[] = [];
    server.use(
      http.post(`${origin}/v1beta/models/:model`, ({ params }) => {
        hits.push(String(params.model));
        return sse([
          {
            candidates: [
              {
                index: 0,
                content: { role: "model", parts: [{ text: "partial answer" }] },
              },
            ],
          },
        ]);
      }),
    );
    const response = await pool.ask({ stream: true });
    expect(response.body).toContain("partial answer");
    expect(response.body).not.toContain('"finish_reason":"stop"');
    expect(hits).toHaveLength(1);
  },
);

for (const wire of ["openai", "anthropic"] as const) {
  for (const complete of [false, true]) {
    poolTest(
      `retains observed Gemini usage without ending the ${wire} stream early (complete=${complete})`,
      async ({ pool }) => {
        let hits = 0;
        server.use(
          http.post(`${origin}/v1beta/models/:model`, () => {
            hits++;
            return sse([
              {
                candidates: [
                  {
                    index: 0,
                    content: { role: "model", parts: [{ text: "partial " }] },
                  },
                ],
                usageMetadata,
              },
              {
                candidates: [
                  {
                    index: 0,
                    content: { role: "model", parts: [{ text: "answer" }] },
                    ...(complete ? { finishReason: "STOP" } : {}),
                  },
                ],
              },
            ]);
          }),
        );
        const response = await pool.ask({ stream: true }, wire);
        expect(response.body).toContain("partial ");
        expect(response.body).toContain("answer");
        if (!complete) {
          expect(response.body).not.toContain('"finish_reason":"stop"');
          expect(response.body).not.toContain("event: message_stop");
        }
        expect(hits).toBe(1);
        const rows = await db
          .select()
          .from(schema.interactionsTable)
          .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          model: "gemini-3.1-flash-lite",
          providerApiKeyId: pool.keyId,
          inputTokens: 16,
          outputTokens: 5,
          cacheReadTokens: 4,
          cost: "0.0000280000",
        });
        const receipts = await InteractionBillingModel.findMany([rows[0].id]);
        expect(receipts).toHaveLength(1);
        if (!complete) {
          expect(receipts[0].usage.status).toBe("incomplete");
          expect(receipts[0].usage.issues).toContain("partial_stream");
        } else {
          expect(receipts[0].usage.issues).not.toContain("partial_stream");
        }
      },
    );
  }
}

poolTest(
  "does not attribute a timed-out member's observed usage to an unavailable sibling",
  async ({ pool, makeLlmProviderApiKey }) => {
    const unavailable = await makeLlmProviderApiKey(pool.organizationId, null, {
      provider: "gemini",
    });
    let hits = 0;
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        hits++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        // Google reported usage, but no visible output to commit this member.
        response.write(`data: ${JSON.stringify({ usageMetadata })}\n\n`);
      });
    });
    onTestFinished(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    server.use(
      http.post(`${baseUrl}/v1beta/models/:model`, () => passthrough()),
    );
    await db
      .update(schema.llmProviderApiKeysTable)
      .set({ baseUrl })
      .where(eq(schema.llmProviderApiKeysTable.id, pool.keyId));
    await ModelPoolModel.update({
      organizationId: pool.organizationId,
      id: pool.poolId,
      input: {
        name: "gemini-pool",
        streamTimeoutSeconds: 1,
        members: [pool.keyId, unavailable.id].map(
          (providerApiKeyId, index) => ({
            providerApiKeyId,
            modelId: index === 0 ? "gemini-3.1-flash-lite" : "gemini-2.5-flash",
            priority: index + 1,
            weight: 1,
            enabled: true,
          }),
        ),
      },
    });
    const response = await pool.ask({ stream: true });
    expect(response.statusCode, response.body).toBe(500);
    expect(hits).toBe(1);
    const rows = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
    expect(rows).toHaveLength(2);
    expect(
      rows.find((row) => row.providerApiKeyId === unavailable.id),
    ).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      model: "gemini-2.5-flash",
      attemptOutcome: "failed",
      failureReason: "key_unavailable",
    });
  },
);

async function configureTestVertexKey(keyId: string, allowGlobal: boolean) {
  config.llm.gemini.vertexAi.enabled = true;
  config.llm.gemini.vertexAi.project = "pool-test-project";
  config.llm.gemini.vertexAi.location = "us-central1";
  config.llm.gemini.vertexAi.allowGlobalEndpoint = allowGlobal;
  config.llm.gemini.vertexAi.credentialsFile = "";
  await db
    .update(schema.llmProviderApiKeysTable)
    .set({ secretId: null, isSystem: true })
    .where(eq(schema.llmProviderApiKeysTable.id, keyId));
  // Substitute only the external credential lookup; the Google client,
  // URL construction, pool and request/response adapters stay real.
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: "synthetic-vertex-token" });
  const getClient = vi
    .spyOn(GoogleAuth.prototype, "getClient")
    .mockResolvedValue(auth);
  onTestFinished(() => getClient.mockRestore());
}

for (const allowGlobal of [false, true]) {
  poolTest(
    `uses the keyless Vertex project and location policy (global allowed=${allowGlobal})`,
    async ({ pool }) => {
      await configureTestVertexKey(pool.keyId, allowGlobal);
      const hits: string[] = [];
      for (const location of ["global", "us-central1"]) {
        const host =
          location === "global"
            ? "aiplatform.googleapis.com"
            : `${location}-aiplatform.googleapis.com`;
        server.use(
          http.post(
            `https://${host}/v1beta1/projects/pool-test-project/locations/${location}/publishers/google/models/:model`,
            ({ request, params }) => {
              hits.push(`${location}/${params.model}`);
              expect(request.headers.get("authorization")).toBe(
                "Bearer synthetic-vertex-token",
              );
              expect(request.headers.get("x-goog-api-key")).toBeNull();
              if (!allowGlobal && String(params.model).startsWith("gemini-3.1"))
                return HttpResponse.json(
                  {
                    error: {
                      code: 404,
                      status: "NOT_FOUND",
                      message: "Not served in this region",
                    },
                  },
                  { status: 404 },
                );
              return HttpResponse.json(answer());
            },
          ),
        );
      }
      const response = await pool.ask();
      expect(response.statusCode, response.body).toBe(200);
      expect(hits).toEqual(
        allowGlobal
          ? ["global/gemini-3.1-flash-lite:generateContent"]
          : [
              "us-central1/gemini-3.1-flash-lite:generateContent",
              "us-central1/gemini-2.5-flash:generateContent",
            ],
      );
      expect(response.headers["x-archestra-provider-key"]).toBe(pool.keyId);
    },
  );
}

poolTest(
  "does not borrow the inbound API key for a keyless Gemini member outside Vertex mode",
  async ({ pool }) => {
    await db
      .update(schema.llmProviderApiKeysTable)
      .set({ secretId: null, isSystem: true })
      .where(eq(schema.llmProviderApiKeysTable.id, pool.keyId));
    let hits = 0;
    server.use(
      http.post(`${origin}/v1beta/models/:model`, () => {
        hits++;
        return HttpResponse.json(answer());
      }),
    );
    const response = await pool.ask();
    expect(response.statusCode).toBe(500);
    expect(hits).toBe(0);
  },
);

for (const name of [
  "frontend_pool",
  "Pool / notes: 50% #1",
  "資料".repeat(256),
]) {
  for (const stream of [false, true]) {
    poolTest(
      `native Gemini resolves an external pool name (${name.slice(0, 30)}, stream=${stream})`,
      async ({ pool }) => {
        await ModelPoolModel.update({
          organizationId: pool.organizationId,
          id: pool.poolId,
          input: {
            name,
            members: [
              {
                providerApiKeyId: pool.keyId,
                modelId: "gemini-2.5-flash",
                priority: 1,
                weight: 1,
                enabled: true,
              },
            ],
          },
        });
        const hits: string[] = [];
        server.use(
          http.post(`${origin}/v1beta/models/:model`, ({ params }) => {
            hits.push(String(params.model));
            return stream ? sse([answer()]) : HttpResponse.json(answer());
          }),
        );
        const operation = stream ? "streamGenerateContent" : "generateContent";
        const response = await pool.app.inject({
          method: "POST",
          url: `/v1/gemini/${pool.agentId}/v1beta/models/${encodeURIComponent(name)}:${operation}`,
          headers: { "x-goog-api-key": pool.token },
          payload: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(hits).toEqual([`gemini-2.5-flash:${operation}`]);
        expect(response.headers["x-archestra-pool"]).toBe(
          encodeURIComponent(name),
        );
        expect(response.headers["x-archestra-provider-key"]).toBe(pool.keyId);
      },
    );
  }
}

for (const first of [0, 1]) {
  poolTest(
    `native Gemini drains all candidates and trailing usage (first=${first})`,
    async ({ pool }) => {
      const candidates = [0, 1].map((index) => ({
        index,
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: `call-${index}`,
                name: "lookup",
                args: { index },
              },
              thoughtSignature: `signature-${index}`,
            },
          ],
        },
        finishReason: "STOP",
      }));
      server.use(
        http.post(`${origin}/v1beta/models/:model`, () =>
          sse([
            {
              candidates: [candidates[first]],
              modelVersion: "gemini-3.1-flash-lite",
            },
            { candidates: [candidates[1 - first]] },
            { usageMetadata },
          ]),
        ),
      );
      const response = await pool.app.inject({
        method: "POST",
        url: `/v1/gemini/${pool.agentId}/v1beta/models/gemini-pool:streamGenerateContent`,
        headers: { "x-goog-api-key": pool.token },
        payload: {
          contents: [{ role: "user", parts: [{ text: "Look up a status." }] }],
          generationConfig: { candidateCount: 2 },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const chunks = response.body
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)));
      expect(chunks.flatMap((chunk) => chunk.candidates ?? [])).toEqual([
        candidates[first],
        candidates[1 - first],
      ]);
      expect(
        chunks.some(
          (chunk) =>
            chunk.usageMetadata?.promptTokenCount ===
            usageMetadata.promptTokenCount,
        ),
      ).toBe(true);
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        inputTokens: 16,
        cacheReadTokens: 4,
        attemptOutcome: "answered",
      });
      expect(rows[0].response).toMatchObject({
        candidates: [candidates[first], candidates[1 - first]],
      });
    },
  );
}

for (const vertex of [false, true]) {
  for (const usePool of [false, true]) {
    for (const mixed of [false, true]) {
      poolTest(
        `native Gemini delivers each parallel tool call once (vertex=${vertex}, pool=${usePool}, mixed=${mixed})`,
        async ({ pool }) => {
          if (vertex) await configureTestVertexKey(pool.keyId, true);
          const credential = await VirtualApiKeyModel.create({
            organizationId: pool.organizationId,
            name: "Native Gemini parallel calls",
            ...accessGrants("org"),
            providerApiKeys: [
              { provider: "gemini", providerApiKeyId: pool.keyId },
            ],
          });
          const parts = [
            ...(mixed
              ? [
                  {
                    text: "Checking the synthetic records.",
                    thought: true,
                    thoughtSignature: "synthetic-text-signature",
                  },
                  {
                    inlineData: { mimeType: "image/png", data: "c3ludGhldGlj" },
                  },
                ]
              : []),
            {
              functionCall: {
                name: "query_knowledge_sources",
                args: { query: "status" },
              },
              thoughtSignature: "synthetic-parallel-signature",
            },
            {
              functionCall: {
                name: "query_knowledge_sources",
                args: { query: "diagram" },
              },
            },
          ];
          const endpoint = vertex
            ? "https://aiplatform.googleapis.com/v1beta1/projects/pool-test-project/locations/global/publishers/google/models/:model"
            : `${origin}/v1beta/models/:model`;
          server.use(http.post(endpoint, () => sse([answer(parts)])));
          const response = await pool.app.inject({
            method: "POST",
            url: `/v1/gemini/${pool.agentId}/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent`,
            headers: {
              "x-goog-api-key": credential.value,
              ...internalCallHeader(),
              ...(usePool ? { [MODEL_POOL_ID_HEADER]: pool.poolId } : {}),
            },
            payload: {
              contents: [
                {
                  role: "user",
                  parts: [{ text: "Look up status and diagram." }],
                },
              ],
            },
          });
          expect(response.statusCode, response.body).toBe(200);
          const streamedParts = response.body
            .split("\n")
            .filter((line) => line.startsWith("data: {"))
            .flatMap(
              (line) =>
                JSON.parse(line.slice(6)).candidates?.[0]?.content?.parts ?? [],
            );
          expect(streamedParts).toEqual(parts);
        },
      );
    }
  }
  for (const failureStatus of [400, 429, 503]) {
    for (const stream of [false, true]) {
      poolTest(
        `native Gemini chat honors its pool and preserves image tool results (vertex=${vertex}, status=${failureStatus}, stream=${stream})`,
        async ({ pool }) => {
          if (vertex) await configureTestVertexKey(pool.keyId, true);
          const credential = await VirtualApiKeyModel.create({
            organizationId: pool.organizationId,
            name: "Native Gemini chat",
            ...accessGrants("org"),
            providerApiKeys: [
              { provider: "gemini", providerApiKeyId: pool.keyId },
            ],
          });
          await ModelPoolModel.update({
            organizationId: pool.organizationId,
            id: pool.poolId,
            input: {
              name: "gemini-pool",
              members: ["gemini-3.8-flash", "gemini-2.5-flash"].map(
                (modelId, index) => ({
                  providerApiKeyId: pool.keyId,
                  modelId,
                  priority: index + 1,
                  weight: 1,
                  enabled: true,
                }),
              ),
            },
          });
          const contents = [
            {
              role: "user",
              parts: [{ text: "What is the synthetic lighthouse status?" }],
            },
            {
              role: "model",
              parts: [
                {
                  thoughtSignature: "synthetic-signature",
                  functionCall: {
                    id: "load",
                    name: "archestra__load_skill",
                    args: { name: "lighthouse" },
                  },
                },
                {
                  functionCall: {
                    id: "lookup",
                    name: "archestra__run_tool",
                    args: {
                      tool_name: "archestra__query_knowledge_sources",
                      tool_args: { query: "lighthouse status" },
                    },
                  },
                },
              ],
            },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    id: "load",
                    name: "archestra__load_skill",
                    response: {
                      name: "archestra__load_skill",
                      content: "Summarize the synthetic lighthouse status.",
                    },
                  },
                },
                {
                  functionResponse: {
                    id: "lookup",
                    name: "archestra__run_tool",
                    response: {
                      name: "archestra__run_tool",
                      content: "The synthetic lighthouse status is GREEN.",
                    },
                  },
                },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                  },
                },
                {
                  text: "Tool executed successfully and returned this image as a response",
                },
              ],
            },
          ];
          const payload = {
            contents,
            generationConfig: {
              maxOutputTokens: 32768,
              thinkingConfig: { includeThoughts: true },
            },
            systemInstruction: {
              parts: [{ text: "Summarize only the synthetic tool results." }],
            },
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
            tools: [
              {
                functionDeclarations: [
                  {
                    name: "archestra__load_skill",
                    description: "Load the synthetic lighthouse instructions.",
                    parameters: {
                      type: "OBJECT",
                      properties: { name: { type: "STRING" } },
                    },
                  },
                  {
                    name: "archestra__run_tool",
                    description: "Look up synthetic records.",
                    parameters: {
                      type: "OBJECT",
                      properties: {
                        tool_name: { type: "STRING" },
                        tool_args: {
                          type: "OBJECT",
                          properties: { query: { type: "STRING" } },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          };
          const hits: string[] = [];
          const endpoints = vertex
            ? ["global", "us-central1"].map((location) => {
                const host =
                  location === "global"
                    ? "aiplatform.googleapis.com"
                    : `${location}-aiplatform.googleapis.com`;
                return `https://${host}/v1beta1/projects/pool-test-project/locations/${location}/publishers/google/models/:model`;
              })
            : [`${origin}/v1beta/models/:model`];
          for (const endpoint of endpoints)
            server.use(
              http.post(endpoint, async ({ request, params }) => {
                hits.push(String(params.model));
                expect(request.headers.get("authorization")).toBe(
                  vertex ? "Bearer synthetic-vertex-token" : null,
                );
                expect(request.headers.get("x-goog-api-key")).toBe(
                  vertex ? null : "selected-gemini-key",
                );
                if (vertex) {
                  const location = String(params.model).startsWith("gemini-3")
                    ? "global"
                    : "us-central1";
                  expect(new URL(request.url).pathname).toContain(
                    `/locations/${location}/`,
                  );
                }
                const body = (await request.json()) as Record<string, unknown>;
                expect(body.contents).toEqual(contents);
                expect(body).toMatchObject(payload);
                if (hits.length === 1)
                  return HttpResponse.json(
                    {
                      error: {
                        code: failureStatus,
                        message:
                          failureStatus === 400
                            ? "Requests ending with a model turn are not supported."
                            : "Temporarily unavailable",
                      },
                    },
                    { status: failureStatus },
                  );
                return stream
                  ? sse([answer([{ text: "Status is GREEN." }])])
                  : HttpResponse.json(answer([{ text: "Status is GREEN." }]));
              }),
            );
          const operation = stream
            ? "streamGenerateContent"
            : "generateContent";
          const response = await pool.app.inject({
            method: "POST",
            url: `/v1/gemini/${pool.agentId}/v1beta/models/gemini-3.8-flash:${operation}`,
            headers: {
              "x-goog-api-key": credential.value,
              ...internalCallHeader(),
              [MODEL_POOL_ID_HEADER]: pool.poolId,
            },
            payload,
          });
          if (failureStatus === 400) {
            expect(response.statusCode, response.body).toBe(400);
            expect(hits).toEqual([`gemini-3.8-flash:${operation}`]);
            const rows = await db
              .select()
              .from(schema.interactionsTable)
              .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
              attemptOutcome: "failed",
              failureReason: "error",
            });
            expect(rows[0].response).toMatchObject({
              error: "Requests ending with a model turn are not supported.",
            });
            return;
          }
          expect(response.statusCode, response.body).toBe(200);
          expect(response.body).toContain("Status is GREEN.");
          expect(hits).toEqual([
            `gemini-3.8-flash:${operation}`,
            `gemini-2.5-flash:${operation}`,
          ]);
          expect(response.headers["x-archestra-provider-key"]).toBe(pool.keyId);
          const rows = await db
            .select()
            .from(schema.interactionsTable)
            .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
          expect(rows).toHaveLength(2);
          expect(rows).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                model: "gemini-3.8-flash",
                attemptOutcome: "failed_over",
                failureReason:
                  failureStatus === 429
                    ? "rate_limited (429)"
                    : "server_error (503)",
              }),
              expect.objectContaining({
                model: "gemini-2.5-flash",
                attemptOutcome: "answered",
                failureReason: null,
              }),
            ]),
          );
        },
      );
    }
  }
}

for (const vertex of [false, true]) {
  for (const stream of [false, true]) {
    for (const weighted of [false, true]) {
      poolTest(
        `native Gemini falls through two 429s to Sonnet and continues parallel image tools (stream=${stream}, weighted=${weighted}, vertex=${vertex})`,
        async ({ pool, makeSecret, makeLlmProviderApiKey }) => {
          if (vertex) await configureTestVertexKey(pool.keyId, true);
          const geminiEndpoint = vertex
            ? "https://aiplatform.googleapis.com/v1beta1/projects/pool-test-project/locations/global/publishers/google/models/:model"
            : `${origin}/v1beta/models/:model`;
          const sonnet = await makeLlmProviderApiKey(
            pool.organizationId,
            (await makeSecret({ secret: { apiKey: "synthetic-sonnet-key" } }))
              .id,
            { provider: "anthropic", baseUrl: "https://sonnet.pool.test" },
          );
          await ModelPoolModel.update({
            organizationId: pool.organizationId,
            id: pool.poolId,
            input: {
              name: "gemini-pool",
              cooldownSeconds: 0,
              members: [
                ...["gemini-3.8-flash", "gemini-3.7-flash"].map(
                  (modelId, index) => ({
                    providerApiKeyId: pool.keyId,
                    modelId,
                    priority: weighted ? 1 : index + 1,
                    weight: weighted && index === 0 ? 99 : 1,
                    enabled: true,
                  }),
                ),
                {
                  providerApiKeyId: sonnet.id,
                  modelId: "claude-sonnet-4-5",
                  priority: weighted ? 1 : 3,
                  weight: 1,
                  enabled: true,
                },
              ],
            },
          });
          const credential = await VirtualApiKeyModel.create({
            organizationId: pool.organizationId,
            name: "Mixed native pool client",
            ...accessGrants("org"),
            providerApiKeys: [
              { provider: "gemini", providerApiKeyId: pool.keyId },
            ],
          });
          const hits: string[] = [];
          let nextTurn = false;
          server.use(
            http.post(geminiEndpoint, ({ request, params }) => {
              expect(request.headers.get("authorization")).toBe(
                vertex ? "Bearer synthetic-vertex-token" : null,
              );
              expect(request.headers.get("x-goog-api-key")).toBe(
                vertex ? null : "selected-gemini-key",
              );
              hits.push(String(params.model));
              return HttpResponse.json(
                {
                  error: {
                    code: 429,
                    status: "RESOURCE_EXHAUSTED",
                    message: "synthetic capacity limit",
                  },
                },
                { status: 429 },
              );
            }),
            http.post(
              "https://sonnet.pool.test/v1/messages",
              async ({ request }) => {
                expect(request.headers.get("x-api-key")).toBe(
                  "synthetic-sonnet-key",
                );
                const body = (await request.json()) as {
                  model: string;
                  max_tokens: number;
                  system: string;
                  messages: { role: string; content: unknown }[];
                  tools: unknown[];
                };
                hits.push(body.model);
                expect(body.model).toBe("claude-sonnet-4-5");
                expect(body.max_tokens).toBe(128);
                expect(body.system).toBe("Use the supplied tools.");
                if (nextTurn) {
                  expect(body.messages).toHaveLength(3);
                  expect(body.messages[1]).toMatchObject({
                    role: "assistant",
                    content: [
                      {
                        type: "tool_use",
                        id: "call_1_0",
                        name: "lookup",
                        input: { item: "one" },
                      },
                      {
                        type: "tool_use",
                        id: "call_1_1",
                        name: "lookup",
                        input: { item: "two" },
                      },
                    ],
                  });
                  expect(body.messages[2]).toMatchObject({
                    role: "user",
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: "call_1_0",
                        content: '{"status":"green"}',
                      },
                      {
                        type: "tool_result",
                        tool_use_id: "call_1_1",
                        content: '{"status":"blue"}',
                      },
                      {
                        type: "image",
                        source: {
                          type: "base64",
                          media_type: "image/png",
                          data: "aW1hZ2U=",
                        },
                      },
                      { type: "text", text: "Inspect the synthetic image." },
                    ],
                  });
                }
                const content: (
                  | { type: "text"; text: string }
                  | {
                      type: "tool_use";
                      id: string;
                      name: string;
                      input: { item: string };
                    }
                )[] = nextTurn
                  ? [{ type: "text", text: "Both results received." }]
                  : [
                      {
                        type: "tool_use",
                        id: "toolu_one",
                        name: "lookup",
                        input: { item: "one" },
                      },
                      {
                        type: "tool_use",
                        id: "toolu_two",
                        name: "lookup",
                        input: { item: "two" },
                      },
                    ];
                const stop_reason = nextTurn ? "end_turn" : "tool_use";
                if (!stream)
                  return HttpResponse.json({
                    id: "msg_synthetic",
                    type: "message",
                    role: "assistant",
                    model: body.model,
                    content,
                    stop_reason,
                    stop_sequence: null,
                    usage: {
                      input_tokens: 20,
                      output_tokens: 5,
                      cache_read_input_tokens: 7,
                      cache_creation_input_tokens: 11,
                    },
                  });
                return sse([
                  {
                    type: "message_start",
                    message: {
                      id: "msg_synthetic",
                      type: "message",
                      role: "assistant",
                      model: body.model,
                      content: [],
                      usage: {
                        input_tokens: 20,
                        output_tokens: 0,
                        cache_read_input_tokens: 7,
                        cache_creation_input_tokens: 11,
                      },
                    },
                  },
                  ...content.flatMap<unknown>((block, index) =>
                    block.type === "tool_use"
                      ? [
                          {
                            type: "content_block_start",
                            index,
                            content_block: { ...block, input: {} },
                          },
                          {
                            type: "content_block_delta",
                            index,
                            delta: {
                              type: "input_json_delta",
                              partial_json: JSON.stringify(block.input).slice(
                                0,
                                5,
                              ),
                            },
                          },
                          {
                            type: "content_block_delta",
                            index,
                            delta: {
                              type: "input_json_delta",
                              partial_json: JSON.stringify(block.input).slice(
                                5,
                              ),
                            },
                          },
                          { type: "content_block_stop", index },
                        ]
                      : [
                          {
                            type: "content_block_start",
                            index,
                            content_block: { type: "text", text: "" },
                          },
                          {
                            type: "content_block_delta",
                            index,
                            delta: { type: "text_delta", text: block.text },
                          },
                          { type: "content_block_stop", index },
                        ],
                  ),
                  {
                    type: "message_delta",
                    delta: { stop_reason, stop_sequence: null },
                    usage: { output_tokens: 5 },
                  },
                  { type: "message_stop" },
                ]);
              },
            ),
          );
          const contents: unknown[] = [
            { role: "user", parts: [{ text: "Check two items." }] },
          ];
          const localUrl = await pool.app.listen({
            port: 0,
            host: "127.0.0.1",
          });
          server.use(
            http.post(
              `${localUrl}/v1/gemini/:agentId/v1beta/models/:model`,
              () => passthrough(),
            ),
          );
          let requestPoolId = pool.poolId;
          const ask = async () => {
            const options = {
              method: "POST",
              url: `/v1/gemini/${pool.agentId}/v1beta/models/gemini-3.8-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
              headers: {
                authorization: `Bearer ${credential.value}`,
                ...internalCallHeader(),
                [MODEL_POOL_ID_HEADER]: requestPoolId,
                "X-Archestra-Session-Id": "mixed-proof-1",
              },
              payload: {
                contents,
                systemInstruction: {
                  parts: [{ text: "Use the supplied tools." }],
                },
                generationConfig: { maxOutputTokens: 128 },
                tools: [
                  {
                    functionDeclarations: [
                      {
                        name: "lookup",
                        description: "Look up an item",
                        parameters: {
                          type: "OBJECT",
                          properties: { item: { type: "STRING" } },
                        },
                      },
                    ],
                  },
                ],
              },
            };
            const response = await fetch(`${localUrl}${options.url}`, {
              method: options.method,
              headers: {
                ...options.headers,
                "content-type": "application/json",
              },
              body: JSON.stringify(options.payload),
            });
            const body = await response.text();
            return {
              statusCode: response.status,
              headers: Object.fromEntries(response.headers),
              body,
              json: () => JSON.parse(body),
            };
          };
          const first = await ask();
          expect(first.statusCode, first.body).toBe(200);
          const frames = stream
            ? first.body
                .split("\n")
                .filter(
                  (line) =>
                    line.startsWith("data: ") && line !== "data: [DONE]",
                )
                .map((line) => JSON.parse(line.slice(6)))
            : [first.json()];
          const calls = frames
            .flatMap((frame) => frame.candidates ?? [])
            .flatMap((candidate) => candidate.content?.parts ?? [])
            .filter((part) => part.functionCall);
          expect(calls).toEqual([
            {
              functionCall: {
                id: "toolu_one",
                name: "lookup",
                args: { item: "one" },
              },
              thoughtSignature: "skip_thought_signature_validator",
            },
            {
              functionCall: {
                id: "toolu_two",
                name: "lookup",
                args: { item: "two" },
              },
              thoughtSignature: "skip_thought_signature_validator",
            },
          ]);
          contents.push(
            { role: "model", parts: calls },
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    id: "toolu_one",
                    name: "lookup",
                    response: { status: "green" },
                  },
                },
                {
                  functionResponse: {
                    id: "toolu_two",
                    name: "lookup",
                    response: { status: "blue" },
                  },
                },
                { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } },
                { text: "Inspect the synthetic image." },
              ],
            },
          );
          nextTurn = true;
          const second = await ask();
          expect(second.statusCode, second.body).toBe(200);
          expect(second.body).toContain("Both results received.");
          expect(second.headers["x-archestra-provider-key"]).toBe(sonnet.id);
          expect(
            hits.filter((hit) => hit === "claude-sonnet-4-5"),
          ).toHaveLength(2);
          expect(hits.filter((hit) => hit.startsWith("gemini-"))).toHaveLength(
            2,
          );
          const rows = await db
            .select()
            .from(schema.interactionsTable)
            .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
          expect(rows).toHaveLength(4);
          expect(
            rows.filter((row) => row.attemptOutcome === "failed_over"),
          ).toHaveLength(2);
          expect(
            rows.filter((row) => row.providerApiKeyId === sonnet.id),
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                model: "claude-sonnet-4-5",
                inputTokens: 20,
                outputTokens: 5,
                cacheReadTokens: 7,
                cacheWriteTokens: 11,
              }),
            ]),
          );
          const returnedPool = await ModelPoolModel.create({
            organizationId: pool.organizationId,
            input: {
              name: "returned-gemini-pool",
              members: [
                {
                  providerApiKeyId: pool.keyId,
                  modelId: "gemini-3.8-flash",
                  priority: 1,
                  weight: 1,
                  enabled: true,
                },
              ],
            },
          });
          requestPoolId = returnedPool.id;
          server.use(
            http.post(geminiEndpoint, async ({ request }) => {
              const body = (await request.json()) as { contents: unknown[] };
              expect(body.contents).toEqual(contents);
              return stream
                ? sse([answer([{ text: "Gemini continuation received." }])])
                : HttpResponse.json(
                    answer([{ text: "Gemini continuation received." }]),
                  );
            }),
          );
          const returned = await ask();
          expect(returned.statusCode, returned.body).toBe(200);
          expect(returned.body).toContain("Gemini continuation received.");
        },
      );
    }
  }
}
for (const stream of [false, true]) {
  poolTest(
    `persists native Gemini 429 errors without a pool (stream=${stream})`,
    async ({ pool }) => {
      const credential = await VirtualApiKeyModel.create({
        organizationId: pool.organizationId,
        name: "Direct native client",
        ...accessGrants("org"),
        providerApiKeys: [{ provider: "gemini", providerApiKeyId: pool.keyId }],
      });
      server.use(
        http.post(`${origin}/v1beta/models/:model`, () =>
          HttpResponse.json(
            {
              error: {
                code: 429,
                status: "RESOURCE_EXHAUSTED",
                message: "synthetic capacity limit",
              },
            },
            { status: 429 },
          ),
        ),
      );
      const response = await pool.app.inject({
        method: "POST",
        url: `/v1/gemini/${pool.agentId}/v1beta/models/gemini-3.8-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
        headers: { authorization: `Bearer ${credential.value}` },
        payload: {
          contents: [{ role: "user", parts: [{ text: "synthetic request" }] }],
        },
      });
      expect(response.statusCode, response.body).toBe(429);
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.profileId, pool.agentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        modelPoolId: null,
        attemptOutcome: "failed",
        failureReason: "rate_limited (429)",
      });
      expect(rows[0].response).toMatchObject({
        error: expect.stringContaining("synthetic capacity limit"),
      });
    },
  );
}

// Explicit opt-in: read an existing local credential, never create one. All
// fixture writes stay in PGlite. At most two tiny live Anthropic generations.
poolTest.skipIf(!process.env.ARCHESTRA_LIVE_POOL_TEST_ENV)(
  "live native Gemini pool falls back to the cheapest available Anthropic model",
  async ({ pool, makeSecret, makeLlmProviderApiKey }) => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { parse } = await import("dotenv");
    const { Client } = await import("pg");
    const { deriveKeyFromSecret, decryptSecretValueWithKey } = await import(
      "@/utils/crypto"
    );
    const env = parse(
      readFileSync(process.env.ARCHESTRA_LIVE_POOL_TEST_ENV as string),
    );
    const source = new Client({
      connectionString: env.ARCHESTRA_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    let credentialValue: string;
    await source.connect();
    try {
      await source.query("BEGIN READ ONLY");
      const result = await source.query(
        "select s.secret from chat_api_keys k join secret s on s.id=k.secret_id where k.provider='anthropic' and k.base_url is null order by k.created_at desc limit 1",
      );
      if (!result.rows[0])
        throw new Error("No existing direct Anthropic credential found");
      const stored = result.rows[0].secret;
      const secret = stored.__encrypted
        ? decryptSecretValueWithKey(
            stored,
            deriveKeyFromSecret(
              env.ARCHESTRA_SECRETS_ENCRYPTION_SECRET ||
                env.ARCHESTRA_AUTH_SECRET,
            ),
          )
        : stored;
      if (typeof secret.apiKey !== "string")
        throw new Error("Existing Anthropic credential has no API key");
      credentialValue = secret.apiKey;
      await source.query("ROLLBACK");
    } finally {
      await source.end();
    }
    server.use(
      http.get("https://api.anthropic.com/v1/models", () => passthrough()),
    );
    const available = await fetch(
      "https://api.anthropic.com/v1/models?limit=100",
      {
        headers: {
          "x-api-key": credentialValue,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!available.ok)
      throw new Error(`Anthropic model discovery failed (${available.status})`);
    const models = (await available.json()) as { data: { id: string }[] };
    // Published standard USD/MTok rates checked against Anthropic pricing.
    const prices = [
      { prefix: "claude-haiku-5-5", input: 0.1, output: 0.5 },
      { prefix: "claude-3-5-haiku", input: 0.8, output: 4 },
      { prefix: "claude-haiku-4-5", input: 1, output: 5 },
    ];
    const selected = prices.flatMap((price) =>
      models.data
        .filter((model) => model.id.startsWith(price.prefix))
        .map((model) => ({ ...price, model: model.id })),
    )[0];
    if (!selected)
      throw new Error(
        "No available Haiku model with verified pricing; stop before inference",
      );
    const evidence: Record<string, unknown> = {
      model: selected.model,
      publishedUsdPerMillion: {
        input: selected.input,
        output: selected.output,
      },
      availableModels: models.data.map((model) => model.id),
      inferenceLimit: 2,
      outputTokenLimitPerCall: 512,
      simulatedBoundary: "Gemini 429 responses",
      liveBoundary: "Anthropic API through native Gemini Archestra HTTP route",
    };
    const saveEvidence = () => {
      if (process.env.ARCHESTRA_LIVE_POOL_TEST_EVIDENCE)
        writeFileSync(
          process.env.ARCHESTRA_LIVE_POOL_TEST_EVIDENCE,
          JSON.stringify(evidence, null, 2),
        );
    };
    if (process.env.ARCHESTRA_LIVE_POOL_TEST_DISCOVERY_ONLY === "true") {
      saveEvidence();
      return;
    }
    const key = await makeLlmProviderApiKey(
      pool.organizationId,
      (await makeSecret({ secret: { apiKey: credentialValue } })).id,
      { provider: "anthropic" },
    );
    await ModelPoolModel.update({
      organizationId: pool.organizationId,
      id: pool.poolId,
      input: {
        name: "gemini-pool",
        members: [
          ...["gemini-3.8-flash", "gemini-3.7-flash"].map((modelId, i) => ({
            providerApiKeyId: pool.keyId,
            modelId,
            priority: i + 1,
            weight: 1,
            enabled: true,
          })),
          {
            providerApiKeyId: key.id,
            modelId: selected.model,
            priority: 3,
            weight: 1,
            enabled: true,
          },
        ],
      },
    });
    const client = await VirtualApiKeyModel.create({
      organizationId: pool.organizationId,
      name: "Bounded mixed-provider proof",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "gemini", providerApiKeyId: pool.keyId }],
    });
    let liveCalls = 0;
    let simulated429s = 0;
    server.use(
      http.post(`${origin}/v1beta/models/:model`, () => {
        simulated429s++;
        return HttpResponse.json(
          {
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "Synthetic capacity limit",
            },
          },
          { status: 429 },
        );
      }),
      http.post(
        "https://api.anthropic.com/v1/messages",
        async ({ request }) => {
          if (++liveCalls > 2)
            throw new Error("Live inference budget exhausted");
          const body = (await request.clone().json()) as {
            model: string;
            max_tokens: number;
          };
          expect(body.model).toBe(selected.model);
          expect(body.max_tokens).toBe(512);
          return passthrough();
        },
      ),
    );
    const localUrl = await pool.app.listen({ port: 0, host: "127.0.0.1" });
    server.use(
      http.post(`${localUrl}/v1/gemini/:agentId/v1beta/models/:model`, () =>
        passthrough(),
      ),
    );
    const contents: unknown[] = [
      {
        role: "user",
        parts: [
          {
            text: "Call lookup twice in parallel: item one and item two. After receiving both results, reply with their colors in five words or fewer.",
          },
        ],
      },
    ];
    const ask = async (mode: "ANY" | "NONE", stream: boolean) => {
      const response = await fetch(
        `${localUrl}/v1/gemini/${pool.agentId}/v1beta/models/gemini-3.8-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${client.value}`,
            ...internalCallHeader(),
            [MODEL_POOL_ID_HEADER]: pool.poolId,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            contents,
            generationConfig: { maxOutputTokens: 512 },
            tools: [
              {
                functionDeclarations: [
                  {
                    name: "lookup",
                    description: "Return a color for an item.",
                    parameters: {
                      type: "OBJECT",
                      properties: {
                        item: { type: "STRING", enum: ["one", "two"] },
                      },
                      required: ["item"],
                    },
                  },
                ],
              },
            ],
            toolConfig: { functionCallingConfig: { mode } },
          }),
          signal: AbortSignal.timeout(45000),
        },
      );
      const body = await response.text();
      if (!response.ok)
        throw new Error(
          `Live Archestra request failed (${response.status}): ${body}`,
        );
      return stream
        ? body
            .split("\n")
            .filter(
              (line) => line.startsWith("data: ") && line !== "data: [DONE]",
            )
            .map((line) => JSON.parse(line.slice(6)))
        : [JSON.parse(body)];
    };
    try {
      const first: Gemini.Types.GenerateContentResponse[] = process.env
        .ARCHESTRA_LIVE_POOL_TEST_CONTINUATION_FILE
        ? JSON.parse(
            readFileSync(
              process.env.ARCHESTRA_LIVE_POOL_TEST_CONTINUATION_FILE,
              "utf8",
            ),
          ).firstResponse
        : await ask("ANY", false);
      evidence.reusedFirstResponse = Boolean(
        process.env.ARCHESTRA_LIVE_POOL_TEST_CONTINUATION_FILE,
      );
      const calls =
        first[0].candidates?.[0]?.content?.parts?.filter(
          (
            part,
          ): part is Gemini.Types.MessagePart & {
            functionCall: {
              id: string;
              name: string;
              args: Record<string, unknown>;
            };
          } => "functionCall" in part && Boolean(part.functionCall),
        ) ?? [];
      evidence.firstResponse = first;
      expect(calls).toHaveLength(2);
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATklEQVR4nO3PMQ0AAAgDsEnHOUjg2tekBppMurJlAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKPA5jH+KaKsa2IAAAAAElFTkSuQmCC";
      contents.push(
        {
          role: "model",
          parts: first[0].candidates?.[0]?.content?.parts ?? [],
        },
        {
          role: "user",
          parts: [
            ...calls.map((part) => ({
              functionResponse: {
                id: part.functionCall.id,
                name: part.functionCall.name,
                response: {
                  color:
                    part.functionCall.args.item === "one" ? "green" : "blue",
                },
              },
            })),
            { inlineData: { mimeType: "image/png", data: png } },
            {
              text: "The image is synthetic. Reply with the two returned colors.",
            },
          ],
        },
      );
      const second = await ask("NONE", true);
      evidence.secondResponse = second;
      const text = second
        .flatMap((frame) => frame.candidates ?? [])
        .flatMap((candidate) => candidate.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .toLowerCase();
      expect(text).toContain("green");
      expect(text).toContain("blue");
      expect(simulated429s).toBe(2);
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
      evidence.attempts = rows.map((row) => ({
        model: row.model,
        attempt: row.attempt,
        outcome: row.attemptOutcome,
        failureReason: row.failureReason,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
      }));
      evidence.result = "PASSED";
    } finally {
      evidence.liveCalls = liveCalls;
      evidence.simulated429s = simulated429s;
      saveEvidence();
    }
  },
);

for (const inbound of ["gemini", "openai", "anthropic"] as const) {
  for (const target of ["gemini", "openai", "anthropic"] as const) {
    if (inbound === target) continue;
    for (const stream of [false, true]) {
      poolTest(
        `three-provider pool translates ${inbound} to ${target}, including parallel image history (stream=${stream})`,
        async ({ pool, makeSecret, makeLlmProviderApiKey }) => {
          const model = {
            gemini: "gemini-3.8-flash",
            openai: "o3-mini",
            anthropic: "claude-sonnet-4-5",
          };
          if (target !== "gemini")
            await ModelModel.create({
              provider: target,
              modelId: model[target],
              externalId: `${target}/${model[target]}`,
              inputModalities: ["text"],
              outputModalities: ["text"],
              customPricePerMillionInput: "1",
              customPricePerMillionOutput: "2",
              customPricePerMillionCacheRead: "0.5",
              customPricePerMillionCacheWrite: "1.25",
            });
          const openai = await makeLlmProviderApiKey(
            pool.organizationId,
            (await makeSecret({ secret: { apiKey: "matrix-openai-key" } })).id,
            { provider: "openai", baseUrl: "https://openai.pool.test/v1" },
          );
          const anthropic = await makeLlmProviderApiKey(
            pool.organizationId,
            (await makeSecret({ secret: { apiKey: "matrix-anthropic-key" } }))
              .id,
            { provider: "anthropic", baseUrl: "https://sonnet.pool.test" },
          );
          const key = {
            gemini: pool.keyId,
            openai: openai.id,
            anthropic: anthropic.id,
          };
          const order = [
            inbound,
            ...(["gemini", "openai", "anthropic"] as const).filter(
              (provider) => provider !== inbound && provider !== target,
            ),
            target,
          ];
          await ModelPoolModel.update({
            organizationId: pool.organizationId,
            id: pool.poolId,
            input: {
              name: "gemini-pool",
              members: order.map((provider, index) => ({
                providerApiKeyId: key[provider],
                modelId: model[provider],
                priority: index + 1,
                weight: 1,
                enabled: true,
              })),
            },
          });
          const credential = await VirtualApiKeyModel.create({
            organizationId: pool.organizationId,
            name: "Three provider matrix",
            ...accessGrants("org"),
            providerApiKeys: [
              { provider: inbound, providerApiKeyId: key[inbound] },
            ],
          });
          const hits: string[] = [];
          const imageData = "c3ludGhldGljLWltYWdl";
          const calls = ["one", "two"].map((item) => ({
            id: item,
            name: "lookup",
            args: { item },
          }));
          for (const provider of ["gemini", "openai", "anthropic"] as const) {
            const endpoint =
              provider === "gemini"
                ? `${origin}/v1beta/models/:model`
                : provider === "openai"
                  ? "https://openai.pool.test/v1/chat/completions"
                  : "https://sonnet.pool.test/v1/messages";
            server.use(
              http.post(endpoint, async ({ request }) => {
                hits.push(provider);
                // Every attempted member receives its own credentials and model.
                expect(
                  request.headers.get(
                    provider === "gemini"
                      ? "x-goog-api-key"
                      : provider === "anthropic"
                        ? "x-api-key"
                        : "authorization",
                  ),
                ).toBe(
                  provider === "gemini"
                    ? "selected-gemini-key"
                    : provider === "anthropic"
                      ? "matrix-anthropic-key"
                      : "Bearer matrix-openai-key",
                );
                const body = (await request.json()) as Record<string, unknown>;
                if (provider !== "gemini")
                  expect(body.model).toBe(model[provider]);
                if (provider === "openai") {
                  expect(body.max_completion_tokens).toBe(64);
                  expect(body).not.toHaveProperty("max_tokens");
                }
                if (provider !== target)
                  return HttpResponse.json(
                    {
                      error: {
                        code: 429,
                        type: "rate_limit_error",
                        message: "Synthetic capacity limit",
                      },
                    },
                    { status: 429 },
                  );
                expect(JSON.stringify(body)).toContain(imageData);
                if (provider === "gemini") {
                  const parts = (
                    body.contents as {
                      parts: {
                        functionCall?: { id: string };
                        functionResponse?: { id: string };
                        thoughtSignature?: string;
                      }[];
                    }[]
                  ).flatMap((content) => content.parts);
                  expect(
                    parts
                      .filter((part) => part.functionCall)
                      .map((part) => part.functionCall?.id)
                      .sort(),
                  ).toEqual(
                    parts
                      .filter((part) => part.functionResponse)
                      .map((part) => part.functionResponse?.id)
                      .sort(),
                  );
                  expect(
                    parts.filter((part) => part.functionResponse),
                  ).toHaveLength(2);
                  expect(
                    parts
                      .filter((part) => part.functionCall)
                      .every(
                        (part) =>
                          part.thoughtSignature ===
                          "skip_thought_signature_validator",
                      ),
                  ).toBe(true);
                  const result = answer([
                    { text: "matrix answer" },
                    {
                      functionCall: {
                        id: "next",
                        name: "lookup",
                        args: { item: "three" },
                      },
                      thoughtSignature: "synthetic-signature",
                    },
                  ]);
                  return stream ? sse([result]) : HttpResponse.json(result);
                }
                if (provider === "anthropic") {
                  const messages = body.messages as {
                    role: string;
                    content:
                      | { type: string; id?: string; tool_use_id?: string }[]
                      | string;
                  }[];
                  const parts = messages.flatMap((message) =>
                    Array.isArray(message.content) ? message.content : [],
                  );
                  expect(
                    parts
                      .filter((part) => part.type === "tool_use")
                      .map((part) => part.id)
                      .sort(),
                  ).toEqual(
                    parts
                      .filter((part) => part.type === "tool_result")
                      .map((part) => part.tool_use_id)
                      .sort(),
                  );
                  expect(
                    messages.filter(
                      (message) =>
                        Array.isArray(message.content) &&
                        message.content.filter(
                          (part) => part.type === "tool_result",
                        ).length === 2,
                    ),
                  ).toHaveLength(1);
                  return stream
                    ? sse([
                        {
                          type: "message_start",
                          message: {
                            id: "matrix",
                            role: "assistant",
                            content: [],
                            model: model.anthropic,
                            usage: {
                              input_tokens: 20,
                              output_tokens: 0,
                              cache_read_input_tokens: 7,
                              cache_creation_input_tokens: 11,
                              cache_creation: { ephemeral_1h_input_tokens: 4 },
                            },
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
                          delta: { type: "text_delta", text: "matrix answer" },
                        },
                        { type: "content_block_stop", index: 0 },
                        {
                          type: "content_block_start",
                          index: 1,
                          content_block: {
                            type: "tool_use",
                            id: "next",
                            name: "lookup",
                            input: {},
                          },
                        },
                        {
                          type: "content_block_delta",
                          index: 1,
                          delta: {
                            type: "input_json_delta",
                            partial_json: '{"item":"three"}',
                          },
                        },
                        { type: "content_block_stop", index: 1 },
                        {
                          type: "message_delta",
                          delta: { stop_reason: "tool_use" },
                          usage: { output_tokens: 9 },
                        },
                        { type: "message_stop" },
                      ])
                    : HttpResponse.json({
                        id: "matrix",
                        type: "message",
                        role: "assistant",
                        model: model.anthropic,
                        content: [
                          { type: "text", text: "matrix answer" },
                          {
                            type: "tool_use",
                            id: "next",
                            name: "lookup",
                            input: { item: "three" },
                          },
                        ],
                        stop_reason: "tool_use",
                        stop_sequence: null,
                        usage: {
                          input_tokens: 20,
                          output_tokens: 9,
                          cache_read_input_tokens: 7,
                          cache_creation_input_tokens: 11,
                          cache_creation: { ephemeral_1h_input_tokens: 4 },
                        },
                      });
                }
                const messages = body.messages as {
                  role: string;
                  content?: unknown;
                  tool_call_id?: string;
                  tool_calls?: { id: string }[];
                }[];
                expect(
                  messages
                    .flatMap((message) => message.tool_calls ?? [])
                    .map((call) => call.id)
                    .sort(),
                ).toEqual(
                  messages
                    .filter((message) => message.role === "tool")
                    .map((message) => message.tool_call_id)
                    .sort(),
                );
                expect(
                  messages.filter((message) => message.role === "tool"),
                ).toHaveLength(2);
                if (inbound === "anthropic") {
                  for (const message of messages.filter(
                    (message) => message.role === "tool",
                  ))
                    expect(typeof message.content).toBe("string");
                  expect(
                    JSON.stringify(
                      messages.filter((message) => message.role === "user"),
                    ),
                  ).toContain("Tool result one attachments");
                }
                const tool = {
                  id: "next",
                  type: "function",
                  function: { name: "lookup", arguments: '{"item":"three"}' },
                };
                const base = { id: "matrix", created: 1, model: model.openai };
                return stream
                  ? sse([
                      {
                        ...base,
                        object: "chat.completion.chunk",
                        choices: [
                          {
                            index: 0,
                            delta: { content: "matrix answer" },
                            finish_reason: null,
                          },
                        ],
                      },
                      {
                        ...base,
                        object: "chat.completion.chunk",
                        choices: [
                          {
                            index: 0,
                            delta: { tool_calls: [{ ...tool, index: 0 }] },
                            finish_reason: "tool_calls",
                          },
                        ],
                      },
                      {
                        ...base,
                        object: "chat.completion.chunk",
                        choices: [],
                        usage: {
                          prompt_tokens: 20,
                          completion_tokens: 9,
                          completion_tokens_details: { reasoning_tokens: 7 },
                          total_tokens: 29,
                        },
                      },
                    ])
                  : HttpResponse.json({
                      ...base,
                      object: "chat.completion",
                      choices: [
                        {
                          index: 0,
                          message: {
                            role: "assistant",
                            content: "matrix answer",
                            tool_calls: [tool],
                          },
                          finish_reason: "tool_calls",
                        },
                      ],
                      usage: {
                        prompt_tokens: 20,
                        completion_tokens: 9,
                        completion_tokens_details: { reasoning_tokens: 7 },
                        total_tokens: 29,
                      },
                    });
              }),
            );
          }
          const parameters = {
            type: "object",
            properties: { item: { type: "string" } },
          };
          const payload =
            inbound === "gemini"
              ? {
                  contents: [
                    { role: "user", parts: [{ text: "Check items" }] },
                    {
                      role: "model",
                      parts: calls.map((call) => ({
                        functionCall: call,
                        thoughtSignature: "synthetic-signature",
                      })),
                    },
                    {
                      role: "user",
                      parts: [
                        ...calls.map((call) => ({
                          functionResponse: {
                            id: call.id,
                            name: call.name,
                            response: { status: call.args.item },
                          },
                        })),
                        {
                          inlineData: {
                            mimeType: "image/png",
                            data: imageData,
                          },
                        },
                      ],
                    },
                  ],
                  generationConfig: { maxOutputTokens: 64 },
                  tools: [
                    {
                      functionDeclarations: [
                        { name: "lookup", description: "Lookup", parameters },
                      ],
                    },
                  ],
                }
              : inbound === "anthropic"
                ? {
                    model: model.anthropic,
                    max_tokens: 64,
                    stream,
                    messages: [
                      { role: "user", content: "Check items" },
                      {
                        role: "assistant",
                        content: calls.map((call) => ({
                          type: "tool_use",
                          id: call.id,
                          name: call.name,
                          input: call.args,
                        })),
                      },
                      {
                        role: "user",
                        content: [
                          ...calls.map((call) => ({
                            type: "tool_result",
                            tool_use_id: call.id,
                            content: [
                              {
                                type: "text",
                                text: JSON.stringify({
                                  status: call.args.item,
                                }),
                              },
                              {
                                type: "image",
                                source: {
                                  type: "base64",
                                  media_type: "image/png",
                                  data: imageData,
                                },
                              },
                            ],
                          })),
                          {
                            type: "image",
                            source: {
                              type: "base64",
                              media_type: "image/png",
                              data: imageData,
                            },
                          },
                        ],
                      },
                    ],
                    tools: [
                      {
                        name: "lookup",
                        description: "Lookup",
                        input_schema: parameters,
                      },
                    ],
                  }
                : {
                    model: model.openai,
                    max_tokens: 64,
                    stream,
                    messages: [
                      { role: "user", content: "Check items" },
                      {
                        role: "assistant",
                        content: null,
                        tool_calls: calls.map((call) => ({
                          type: "function",
                          id: call.id,
                          function: {
                            name: call.name,
                            arguments: JSON.stringify(call.args),
                          },
                        })),
                      },
                      ...calls.map((call) => ({
                        role: "tool",
                        tool_call_id: call.id,
                        content: JSON.stringify({ status: call.args.item }),
                      })),
                      {
                        role: "user",
                        content: [
                          {
                            type: "image_url",
                            image_url: {
                              url: `data:image/png;base64,${imageData}`,
                            },
                          },
                        ],
                      },
                    ],
                    tools: [
                      {
                        type: "function",
                        function: {
                          name: "lookup",
                          description: "Lookup",
                          parameters,
                        },
                      },
                    ],
                  };
          const exporter = new InMemorySpanExporter();
          const originalTracer = trace.getTracerProvider();
          const tracerProvider = new BasicTracerProvider({
            spanProcessors: [new SimpleSpanProcessor(exporter)],
          });
          trace.disable();
          trace.setGlobalTracerProvider(tracerProvider);
          onTestFinished(async () => {
            await tracerProvider.shutdown();
            trace.disable();
            trace.setGlobalTracerProvider(originalTracer);
          });
          const response = await pool.app.inject({
            method: "POST",
            url:
              inbound === "gemini"
                ? `/v1/gemini/${pool.agentId}/v1beta/models/${model.gemini}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`
                : inbound === "anthropic"
                  ? `/v1/anthropic/${pool.agentId}/v1/messages`
                  : `/v1/openai/${pool.agentId}/chat/completions`,
            headers: {
              authorization: `Bearer ${credential.value}`,
              "anthropic-version": "2023-06-01",
              ...internalCallHeader(),
              [MODEL_POOL_ID_HEADER]: pool.poolId,
            },
            payload,
          });
          expect(response.statusCode, response.body).toBe(200);
          expect(hits).toEqual(order);
          expect(response.body).toContain("matrix answer");
          expect(response.body).toContain("three");
          expect(response.body).toContain(
            inbound === "gemini"
              ? '"functionCall"'
              : inbound === "anthropic"
                ? '"tool_use"'
                : '"tool_calls"',
          );
          expect(response.headers["x-archestra-provider-key"]).toBe(
            key[target],
          );
          const rows = await db
            .select()
            .from(schema.interactionsTable)
            .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
          expect(rows).toHaveLength(3);
          if (inbound === "gemini" && target !== "gemini") {
            const answered = rows.find(
              (row) => row.attemptOutcome === "answered",
            );
            expect(answered).toMatchObject({
              inputTokens: 20,
              outputTokens: 9,
              ...(target === "anthropic"
                ? {
                    cacheReadTokens: 7,
                    cacheWriteTokens: 11,
                    cacheWrite1hTokens: 4,
                  }
                : {}),
            });
            if (stream) {
              const emitted = response.body
                .split("\n")
                .filter(
                  (line) =>
                    line.startsWith("data: ") && line !== "data: [DONE]",
                )
                .map(
                  (line) =>
                    JSON.parse(
                      line.slice(6),
                    ) as Gemini.Types.GenerateContentResponse,
                );
              const wireUsage = emitted.find(
                (frame) => frame.usageMetadata,
              )?.usageMetadata;
              expect(wireUsage).toMatchObject({
                promptTokenCount: target === "anthropic" ? 38 : 20,
                candidatesTokenCount: target === "anthropic" ? 9 : 2,
                thoughtsTokenCount: target === "anthropic" ? 0 : 7,
                totalTokenCount: target === "anthropic" ? 47 : 29,
              });
              const loggedUsage = (
                answered?.response as Gemini.Types.GenerateContentResponse
              ).usageMetadata;
              expect(loggedUsage).toMatchObject({
                promptTokenCount: wireUsage?.promptTokenCount,
                candidatesTokenCount: wireUsage?.candidatesTokenCount,
                totalTokenCount: wireUsage?.totalTokenCount,
              });
              expect(loggedUsage?.thoughtsTokenCount ?? 0).toBe(
                wireUsage?.thoughtsTokenCount,
              );
              expect(loggedUsage?.cachedContentTokenCount ?? 0).toBe(
                wireUsage?.cachedContentTokenCount,
              );
              const span = exporter
                .getFinishedSpans()
                .find((span) => span.name.startsWith("generate_content "));
              expect(span?.attributes).toMatchObject({
                "gen_ai.usage.input_tokens": target === "anthropic" ? 38 : 20,
                "gen_ai.usage.output_tokens": 9,
                "gen_ai.usage.total_tokens": target === "anthropic" ? 47 : 29,
                ...(target === "anthropic"
                  ? {
                      "gen_ai.usage.cache_read.input_tokens": 7,
                      "gen_ai.usage.cache_creation.input_tokens": 11,
                      "archestra.usage.cache_creation.1h_input_tokens": 4,
                    }
                  : { "gen_ai.usage.reasoning.output_tokens": 7 }),
              });
              expect(Number(answered?.cost)).toBeGreaterThan(0);
              expect(span?.attributes["archestra.cost"]).toBeCloseTo(
                Number(answered?.cost),
                10,
              );
            }
          }
          expect(
            rows.filter((row) => row.attemptOutcome === "failed_over"),
          ).toHaveLength(2);
          expect(
            rows.find((row) => row.attemptOutcome === "answered")?.model,
          ).toBe(model[target]);
        },
      );
    }
  }
}

for (const stream of [false, true]) {
  poolTest(
    `records billed malformed foreign tool output without invoking another member (stream=${stream})`,
    async ({ pool, makeSecret, makeLlmProviderApiKey }) => {
      const key = await makeLlmProviderApiKey(
        pool.organizationId,
        (await makeSecret({ secret: { apiKey: "synthetic-openai-key" } })).id,
        { provider: "openai", baseUrl: "https://openai.pool.test/v1" },
      );
      await ModelPoolModel.update({
        organizationId: pool.organizationId,
        id: pool.poolId,
        input: {
          name: "gemini-pool",
          members: ["gpt-4.1-mini", "gpt-4.1"].map((modelId, index) => ({
            providerApiKeyId: key.id,
            modelId,
            priority: index + 1,
            weight: 1,
            enabled: true,
          })),
        },
      });
      const credential = await VirtualApiKeyModel.create({
        organizationId: pool.organizationId,
        name: "Malformed response proof",
        ...accessGrants("org"),
        providerApiKeys: [{ provider: "gemini", providerApiKeyId: pool.keyId }],
      });
      let hits = 0;
      server.use(
        http.post("https://openai.pool.test/v1/chat/completions", () => {
          hits++;
          const response = {
            id: "invalid",
            object: "chat.completion",
            created: 1,
            model: "gpt-4.1-mini",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      type: "function",
                      id: "broken",
                      function: { name: "lookup", arguments: '{"broken":' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 9,
              total_tokens: 29,
            },
          };
          return stream
            ? sse([
                {
                  id: response.id,
                  object: "chat.completion.chunk",
                  created: 1,
                  model: response.model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            ...response.choices[0].message.tool_calls[0],
                            index: 0,
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                },
                {
                  id: response.id,
                  object: "chat.completion.chunk",
                  created: 1,
                  model: response.model,
                  choices: [],
                  usage: response.usage,
                },
              ])
            : HttpResponse.json(response);
        }),
      );
      const response = await pool.app.inject({
        method: "POST",
        url: `/v1/gemini/${pool.agentId}/v1beta/models/gemini-3.8-flash:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
        headers: {
          authorization: `Bearer ${credential.value}`,
          ...internalCallHeader(),
          [MODEL_POOL_ID_HEADER]: pool.poolId,
        },
        payload: {
          contents: [{ role: "user", parts: [{ text: "Use a tool" }] }],
        },
      });
      expect(response.statusCode, response.body).toBe(502);
      expect(hits).toBe(1);
      const rows = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.modelPoolId, pool.poolId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        attemptOutcome: "failed",
        model: "gpt-4.1-mini",
        inputTokens: 20,
        outputTokens: 9,
        response: { error: "Upstream returned invalid function arguments" },
      });
    },
  );
}
