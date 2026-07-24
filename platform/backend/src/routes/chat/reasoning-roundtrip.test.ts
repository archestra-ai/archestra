/**
 * Regression test for #4951: a chat turn with tool calls on a DeepSeek-style
 * thinking model must round-trip the assistant's `reasoning_content` back to
 * the provider — both within a multi-step tool turn and across conversation
 * turns from persisted history. DeepSeek 400s a tool-call turn whose assistant
 * message omits `reasoning_content` ("The reasoning_content in the thinking
 * mode must be passed back to the API"), so dropping the field anywhere in the
 * chat pipeline breaks the turn.
 *
 * Scope: this file pins the CHAT-PIPELINE half of the fix — that
 * `reasoning_content` is preserved within a tool turn, into the UI stream, and
 * across turns reloaded from persisted history. It runs the real chat route,
 * the real agentic loop (streamText / runAgentStream / toUIMessageStream), and
 * real message persistence, but it MOCKS `createLLMModelForAgent` and injects
 * its own `@ai-sdk/openai-compatible` model, so it does NOT exercise the fix's
 * provider-choice half — the deepseek → openai-compatible client swap in
 * llm-client.ts. That half is guarded by llm-client.test.ts (asserting
 * `createDirectLLMModel({provider:"deepseek"}).provider === "deepseek.chat"`),
 * and the non-streaming / proxy-schema half by the proxy provider matrix
 * (routes/proxy/routes/provider-matrix.test.ts). Only two things are faked
 * here: the MCP gateway (a single `read_file` tool) and the LLM upstream (MSW).
 *
 * The mock upstream enforces the reasoning rule STRICTLY: it 400s any tool-call
 * assistant message missing `reasoning_content`, and — unlike the real
 * api.deepseek.com — does NOT waive it for provider-issued tool_call ids. That
 * server-side waiver is precisely what hides this bug in manual testing, so the
 * mock must never replicate it or the regression becomes invisible again.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, tool } from "ai";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { ModelModel } from "@/models";
import MessageModel from "@/models/message";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { User } from "@/types";

const UPSTREAM_BASE_URL = "https://deepseek.test/v1";
const UPSTREAM_URL = `${UPSTREAM_BASE_URL}/chat/completions`;
const DEEPSEEK_REASONING_400 =
  "The `reasoning_content` in the thinking mode must be passed back to the API.";

const RESPONSE_REASONING = "The file contains hello; I can answer now.";
const FINAL_TEXT = "The file /tmp/a.txt contains: hello";

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
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

function chunk(delta: Delta, finishReason: string | null = null) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-v4-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const USAGE_CHUNK = {
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 0,
  model: "deepseek-v4-flash",
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

// The step-1 response: reasoning, then a read_file tool call.
const TOOL_CALL_CHUNKS = [
  chunk({ role: "assistant", reasoning_content: RESPONSE_REASONING }),
  chunk({
    tool_calls: [
      {
        index: 0,
        id: "call_test_1",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "/tmp/a.txt" }),
        },
      },
    ],
  }),
  chunk({}, "tool_calls"),
  USAGE_CHUNK,
];

// The final response: reasoning, then the answer text.
const FINAL_CHUNKS = [
  chunk({ role: "assistant", reasoning_content: RESPONSE_REASONING }),
  chunk({ content: FINAL_TEXT }),
  chunk({}, "stop"),
  USAGE_CHUNK,
];

/**
 * DeepSeek's rule: every assistant message carrying tool_calls must also carry
 * a non-empty `reasoning_content`. Deliberately does NOT waive it for known
 * tool_call ids (real DeepSeek does; that waiver is what masks the bug).
 */
function everyToolCallTurnHasReasoning(messages: unknown[]): boolean {
  return messages.every((raw) => {
    const message = raw as {
      role?: string;
      tool_calls?: unknown[];
      reasoning_content?: unknown;
    };
    if (message.role !== "assistant") return true;
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      return true;
    }
    return (
      typeof message.reasoning_content === "string" &&
      message.reasoning_content.length > 0
    );
  });
}

describe("POST /api/chat DeepSeek reasoning_content round-trip (#4951)", () => {
  const server = useMswServer();

  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;
  let upstreamRequests: Array<{
    messages: Array<{ role: string; reasoning_content?: string }>;
  }>;

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      upstreamRequests = [];

      user = await makeUser();
      const organization = await makeOrganization({ name: "Test Org" });
      organizationId = organization.id;

      const agent = await makeAgent({
        organizationId,
        name: "DeepSeek Agent",
        systemPrompt: "You are a helpful assistant with tools.",
      });

      const model = await ModelModel.create({
        externalId: "deepseek/deepseek-v4-flash",
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
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
        name: "deepseek",
        apiKey: "test-key",
        baseURL: UPSTREAM_BASE_URL,
        includeUsage: true,
      }).chatModel("deepseek-v4-flash");

      mockCreateLLMModelForAgent.mockResolvedValue({
        model: llmModel,
        provider: "deepseek",
        apiKeySource: "org",
        anthropicNativeEndpoint: false,
      });

      mockGetChatMcpTools.mockResolvedValue({
        read_file: tool({
          description: "Read a file from disk",
          inputSchema: jsonSchema({
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          }),
          execute: async () => "hello",
        }),
      });
      mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
      mockExtractAndIngestDocuments.mockResolvedValue(undefined);

      server.use(
        http.post(UPSTREAM_URL, async ({ request }) => {
          const body = (await request.json()) as {
            messages: Array<{ role: string; reasoning_content?: string }>;
          };
          upstreamRequests.push(body);

          if (!everyToolCallTurnHasReasoning(body.messages)) {
            return HttpResponse.json(
              {
                error: {
                  message: DEEPSEEK_REASONING_400,
                  type: "invalid_request_error",
                  code: "invalid_request_error",
                },
              },
              { status: 400 },
            );
          }

          const hasToolResult = body.messages.some((m) => m.role === "tool");
          return sse(hasToolResult ? FINAL_CHUNKS : TOOL_CALL_CHUNKS);
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

  function userMessage(text: string) {
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }],
    };
  }

  // useChat resends the whole conversation each turn, so `history` (the reloaded
  // UIMessages) is prepended to the new user message — not just the new one.
  async function sendMessages(messages: unknown[]) {
    return app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { id: conversationId, trigger: "submit-message", messages },
    });
  }

  test("passes reasoning_content back on the tool-call follow-up turn", async () => {
    const response = await sendMessages([userMessage("Read /tmp/a.txt")]);

    expect(response.statusCode).toBe(200);
    // The turn completed end to end: tool call executed, model answered.
    expect(response.body).toContain(FINAL_TEXT);
    // No upstream call was rejected — the reasoning rule was satisfied.
    expect(response.body).not.toContain(DEEPSEEK_REASONING_400);

    // The follow-up upstream call (after the tool result) carried the
    // assistant's reasoning_content verbatim on the tool-call message. This is
    // the exact field the strict openai client dropped before the fix.
    expect(upstreamRequests.length).toBeGreaterThanOrEqual(2);
    const followUp = upstreamRequests.at(-1);
    const toolCallTurn = followUp?.messages.find(
      (m) => m.role === "assistant" && m.reasoning_content !== undefined,
    );
    expect(toolCallTurn?.reasoning_content).toBe(RESPONSE_REASONING);
  });

  test("streams the reasoning to the client", async () => {
    const response = await sendMessages([userMessage("Read /tmp/a.txt")]);

    expect(response.statusCode).toBe(200);
    // The thinking block reaches the UI stream (reasoning parts), not just the
    // wire — before the fix the strict client also dropped it from responses.
    expect(response.body).toContain("reasoning");
    expect(response.body).toContain(RESPONSE_REASONING);
    // The streamed reasoning above already appears on the FIRST upstream
    // response (before the tool-call follow-up), so guard the whole turn too:
    // it must run through the follow-up round-trip to completion, not 400.
    // Otherwise a broken follow-up would leave this test green.
    expect(response.body).toContain(FINAL_TEXT);
    expect(response.body).not.toContain(DEEPSEEK_REASONING_400);
  });

  test("keeps reasoning_content across conversation turns from persisted history", async () => {
    const first = await sendMessages([userMessage("Read /tmp/a.txt")]);
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain(FINAL_TEXT);

    // Wait until the first turn's assistant message (with its reasoning) is
    // persisted, so the second turn can reload it from the DB.
    await expect
      .poll(
        async () =>
          (await MessageModel.findByConversation(conversationId)).length,
      )
      .toBeGreaterThanOrEqual(2);

    // The next turn is driven exactly as the frontend drives it: the reloaded
    // conversation (persisted UIMessages) plus the new user message. The prior
    // assistant turn's reasoning part must survive reload → convertToModelMessages
    // → the provider request, or the strict upstream 400s this turn's first call.
    const history = (await MessageModel.findByConversation(conversationId)).map(
      (message) => message.content,
    );
    upstreamRequests = [];

    const second = await sendMessages([
      ...history,
      userMessage("Thanks, anything else in it?"),
    ]);

    expect(second.statusCode).toBe(200);
    expect(second.body).not.toContain(DEEPSEEK_REASONING_400);

    // The reloaded history carried the tool-call turn's reasoning_content.
    const firstCall = upstreamRequests[0];
    const historicalToolCallTurn = firstCall?.messages.find(
      (m) =>
        m.role === "assistant" &&
        (m as { tool_calls?: unknown[] }).tool_calls !== undefined,
    );
    expect(historicalToolCallTurn?.reasoning_content).toBe(RESPONSE_REASONING);
  });
});
