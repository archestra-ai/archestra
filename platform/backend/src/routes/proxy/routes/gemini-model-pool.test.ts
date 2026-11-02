import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { HttpResponse, http, passthrough } from "msw";
import { onTestFinished, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelModel, ModelPoolModel, VirtualApiKeyModel } from "@/models";
import { accessGrants, beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import anthropicRoutes from "./anthropic";
import azureRoutes from "./azure";
import groqRoutes from "./groq";
import mistralRoutes from "./mistral";
import modelRouterRoutes from "./model-router";
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
          : '"stop_reason":"end_turn"',
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

for (const allowGlobal of [false, true]) {
  poolTest(
    `uses the keyless Vertex project and location policy (global allowed=${allowGlobal})`,
    async ({ pool }) => {
      config.llm.gemini.vertexAi.enabled = true;
      config.llm.gemini.vertexAi.project = "pool-test-project";
      config.llm.gemini.vertexAi.location = "us-central1";
      config.llm.gemini.vertexAi.allowGlobalEndpoint = allowGlobal;
      config.llm.gemini.vertexAi.credentialsFile = "";
      await db
        .update(schema.llmProviderApiKeysTable)
        .set({ secretId: null, isSystem: true })
        .where(eq(schema.llmProviderApiKeysTable.id, pool.keyId));
      // Substitute only the external credential lookup; the Google client,
      // URL construction, pool and request/response adapters stay real.
      const auth = new OAuth2Client();
      auth.setCredentials({ access_token: "synthetic-vertex-token" });
      const getClient = vi
        .spyOn(GoogleAuth.prototype, "getClient")
        .mockResolvedValue(auth);
      onTestFinished(() => getClient.mockRestore());
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
