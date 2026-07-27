/**
 * OpenRouter reasoning models stream thinking as a `reasoning` delta field —
 * the alias, NOT the `reasoning_content` field DeepSeek uses (that spelling is
 * covered by reasoning-roundtrip.test.ts). The strict @ai-sdk/openai chat
 * parser drops the field entirely, so with the old client the thinking never
 * reached the UI. This file pins the CHAT-PIPELINE half of the fix: a
 * `reasoning` delta from the upstream must surface as reasoning parts in the
 * UI stream, and the request must still carry `stream_options.include_usage`
 * (the compatible client only sends it when asked; without it the final usage
 * chunk — and with it cost/usage metrics — is lost).
 *
 * Like reasoning-roundtrip.test.ts, this runs the real chat route and real
 * agentic loop but MOCKS `createLLMModelForAgent`, injecting the exact
 * openai-compatible client the fix wires up, pointed at an MSW upstream. The
 * provider-choice half — that OpenRouter actually gets that client — is
 * guarded by llm-client.test.ts (`provider === "openrouter.chat"`).
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { ModelModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { User } from "@/types";

const UPSTREAM_BASE_URL = "https://openrouter.test/api/v1";
const UPSTREAM_URL = `${UPSTREAM_BASE_URL}/chat/completions`;

const RESPONSE_REASONING = "Let me count the legs before answering.";
const FINAL_TEXT = "23 chickens and 12 rabbits.";

const mockCreateLLMModelForAgent = vi.hoisted(() =>
  vi.fn<typeof import("@/clients/llm-client").createLLMModelForAgent>(),
);
const mockGetChatMcpTools = vi.hoisted(() => vi.fn());
const mockGetChatMcpToolUiResourceUris = vi.hoisted(() => vi.fn());
const mockExtractAndIngestDocuments = vi.hoisted(() => vi.fn());

vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return { ...actual, createLLMModelForAgent: mockCreateLLMModelForAgent };
});

vi.mock("@/clients/chat-mcp-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/chat-mcp-client")>();
  return {
    ...actual,
    getChatMcpTools: mockGetChatMcpTools,
    getChatMcpToolUiResourceUris: mockGetChatMcpToolUiResourceUris,
  };
});

vi.mock("@/knowledge-base", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/knowledge-base")>();
  return {
    ...actual,
    extractAndIngestDocuments: mockExtractAndIngestDocuments,
  };
});

// ===== SSE helpers (OpenAI chat.completion.chunk shape) =====

interface Delta {
  role?: "assistant";
  content?: string | null;
  /** OpenRouter's field name for streamed thinking (no `reasoning_content`). */
  reasoning?: string;
}

function chunk(delta: Delta, finishReason: string | null = null) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek/deepseek-r1",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const USAGE_CHUNK = {
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 0,
  model: "deepseek/deepseek-r1",
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
};

function sse(chunks: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new HttpResponse(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

const RESPONSE_CHUNKS = [
  chunk({ role: "assistant", reasoning: RESPONSE_REASONING }),
  chunk({ content: FINAL_TEXT }),
  chunk({}, "stop"),
  USAGE_CHUNK,
];

describe("POST /api/chat OpenRouter `reasoning` delta", () => {
  const server = useMswServer();

  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;
  let upstreamRequests: Array<{
    stream_options?: { include_usage?: boolean };
  }>;

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      upstreamRequests = [];

      user = await makeUser();
      const organization = await makeOrganization({ name: "Test Org" });
      organizationId = organization.id;

      const agent = await makeAgent({
        organizationId,
        name: "OpenRouter Agent",
        systemPrompt: "You are a helpful assistant.",
      });

      const model = await ModelModel.create({
        externalId: "openrouter/deepseek/deepseek-r1",
        provider: "openrouter",
        modelId: "deepseek/deepseek-r1",
        supportsToolCalling: true,
        contextLength: 128000,
        outputLength: 8192,
        inputModalities: ["text"],
        outputModalities: ["text"],
      });

      const conversation = await makeConversation(agent.id, {
        userId: user.id,
        organizationId,
        modelId: model.id,
      });
      conversationId = conversation.id;

      // Real openai-compatible model — the exact client the fix wires up —
      // pointed straight at the mock upstream (the in-process proxy hop is
      // covered by the provider matrix).
      const llmModel = createOpenAICompatible({
        name: "openrouter",
        apiKey: "test-key",
        baseURL: UPSTREAM_BASE_URL,
        includeUsage: true,
      }).chatModel("deepseek/deepseek-r1");

      mockCreateLLMModelForAgent.mockResolvedValue({
        model: llmModel,
        provider: "openrouter",
        apiKeySource: "org",
        anthropicNativeEndpoint: false,
      });

      mockGetChatMcpTools.mockResolvedValue({});
      mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
      mockExtractAndIngestDocuments.mockResolvedValue(undefined);

      server.use(
        http.post(UPSTREAM_URL, async ({ request }) => {
          upstreamRequests.push(
            (await request.json()) as (typeof upstreamRequests)[number],
          );
          return sse(RESPONSE_CHUNKS);
        }),
      );

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = user;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });

      const { default: chatRoutes } = await import("./routes");
      await app.register(chatRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("streams the reasoning to the client as reasoning parts", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        trigger: "submit-message",
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "35 heads, 94 legs — how many?" }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    // The `reasoning` delta (OpenRouter's alias, no reasoning_content) reaches
    // the UI stream as reasoning parts — the strict openai client dropped it.
    expect(response.body).toContain('"type":"reasoning-delta"');
    expect(response.body).toContain(RESPONSE_REASONING);
    expect(response.body).toContain(FINAL_TEXT);

    // The compatible client only sends stream_options.include_usage when
    // asked; the openrouter config must keep it on or usage/cost is lost.
    expect(upstreamRequests[0]?.stream_options?.include_usage).toBe(true);
  });
});
