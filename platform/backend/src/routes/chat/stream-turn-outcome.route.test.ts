/**
 * How a chat turn ends: a tool error mid-turn, an upstream that stops sending
 * data, and a reply the model finished for a reason other than a clean stop.
 * Runs the real chat route, agentic loop and persistence; only the model
 * (MockLanguageModelV3, or a real openai-compatible client against a local SSE
 * server) and the tool list are injected.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ChatErrorCode, TURN_NOTICE_PART_TYPE } from "@archestra/shared";
import { jsonSchema, simulateReadableStream, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { desc, eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelModel } from "@/models";
import MessageModel from "@/models/message";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";

const mockCreateLLMModelForAgent = vi.hoisted(() =>
  vi.fn<typeof import("@/clients/llm-client").createLLMModelForAgent>(),
);
const mockGetChatMcpTools = vi.hoisted(() => vi.fn());
const mockGetChatMcpToolUiResourceUris = vi.hoisted(() => vi.fn());

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

type DoStreamResult = Extract<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doStream"],
  { stream: unknown }
>;
type ModelStreamPart =
  DoStreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type FinishReason = "stop" | "tool-calls" | "length" | "other";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function finish(reason: FinishReason): ModelStreamPart {
  return {
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage,
  };
}

function textReply(text: string, reason: FinishReason): DoStreamResult {
  return {
    stream: simulateReadableStream<ModelStreamPart>({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        finish(reason),
      ],
    }),
  };
}

function toolCallReply(toolName: string): DoStreamResult {
  return {
    stream: simulateReadableStream<ModelStreamPart>({
      chunks: [
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName,
          input: JSON.stringify({ path: "/tmp/a.txt" }),
        },
        finish("tool-calls"),
      ],
    }),
  };
}

type StreamChunk = { type: string; [key: string]: unknown };

function parseChunks(body: string): StreamChunk[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as StreamChunk);
}

describe("POST /api/chat turn outcome", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;

  beforeEach(
    async ({
      makeAgent,
      makeConversation,
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      user = await makeUser();
      const organization = await makeOrganization({ name: "Test Org" });
      organizationId = organization.id;
      await makeMember(user.id, organizationId);

      const agent = await makeAgent({
        organizationId,
        name: "Outcome Agent",
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

      mockGetChatMcpTools.mockResolvedValue({});
      mockGetChatMcpToolUiResourceUris.mockResolvedValue({});

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

  function useModel(
    llmModel: Awaited<ReturnType<typeof mockCreateLLMModelForAgent>>["model"],
  ) {
    mockCreateLLMModelForAgent.mockResolvedValue({
      model: llmModel,
      provider: "deepseek",
      apiKeySource: "org",
      anthropicNativeEndpoint: false,
    });
  }

  async function sendTurn(text: string) {
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
            parts: [{ type: "text", text }],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    return parseChunks(response.body);
  }

  async function persistedAssistantParts(): Promise<
    UIMessage["parts"] | undefined
  > {
    let parts: UIMessage["parts"] | undefined;
    await expect
      .poll(async () => {
        const rows = await MessageModel.findByConversation(conversationId);
        parts = rows
          .map((row) => row.content as UIMessage)
          .find((message) => message.role === "assistant")?.parts;
        return parts !== undefined;
      })
      .toBe(true);
    return parts;
  }

  async function runStatus() {
    const [run] = await db
      .select({ status: schema.chatActiveRunsTable.status })
      .from(schema.chatActiveRunsTable)
      .where(eq(schema.chatActiveRunsTable.conversationId, conversationId))
      .orderBy(desc(schema.chatActiveRunsTable.createdAt))
      .limit(1);
    return run?.status;
  }

  test("keeps the assistant reply when a tool's execute throws", async () => {
    mockGetChatMcpTools.mockResolvedValue({
      read_file: tool({
        description: "Read a file from disk",
        inputSchema: jsonSchema<{ path: string }>({
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        }),
        execute: async (): Promise<string> => {
          throw new ApiError(502, "file backend unavailable");
        },
      }),
    });
    let calls = 0;
    useModel(
      new MockLanguageModelV3({
        doStream: async () =>
          calls++ === 0
            ? toolCallReply("read_file")
            : textReply("The file could not be read.", "stop"),
      }),
    );

    const chunks = await sendTurn("Read /tmp/a.txt");

    expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([]);
    expect(
      chunks.find((chunk) => chunk.type === "tool-output-error"),
    ).toMatchObject({ errorText: "file backend unavailable" });

    const parts = await persistedAssistantParts();
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "call_1",
          state: "output-error",
          errorText: "file backend unavailable",
        }),
        expect.objectContaining({
          type: "text",
          text: "The file could not be read.",
        }),
      ]),
    );
    await expect.poll(runStatus).toBe("completed");
  });

  test.each([
    "length",
    "other",
  ] as const)("persists a notice with a reply that finished with %s", async (reason) => {
    useModel(
      new MockLanguageModelV3({
        doStream: async () => textReply("Here is the first half", reason),
      }),
    );

    const chunks = await sendTurn("Write a long answer");

    const notice = chunks.find((chunk) => chunk.type === TURN_NOTICE_PART_TYPE);
    expect(notice).toMatchObject({
      data: { code: ChatErrorCode.IncompleteResponse, isRetryable: false },
    });
    expect(chunks.filter((chunk) => chunk.type === "error")).toEqual([]);

    const parts = await persistedAssistantParts();
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: "Here is the first half",
        }),
        expect.objectContaining({
          type: TURN_NOTICE_PART_TYPE,
          data: notice?.data,
        }),
      ]),
    );
    await expect.poll(runStatus).toBe("completed");
  });

  test("adds no notice to a reply that finished cleanly", async () => {
    useModel(
      new MockLanguageModelV3({
        doStream: async () => textReply("Done.", "stop"),
      }),
    );

    const chunks = await sendTurn("Say done");

    expect(chunks.map((chunk) => chunk.type)).not.toContain(
      TURN_NOTICE_PART_TYPE,
    );
    const parts = await persistedAssistantParts();
    expect(parts?.map((part) => part.type)).not.toContain(
      TURN_NOTICE_PART_TYPE,
    );
  });

  describe("upstream that stops sending data", () => {
    let upstream: Server;
    let upstreamUrl: string;
    let upstreamClosed: boolean;
    const originalIdleTimeoutMs = config.chat.modelStreamIdleTimeoutMs;

    beforeEach(async () => {
      upstreamClosed = false;
      config.chat.modelStreamIdleTimeoutMs = 300;
      upstream = createServer((request, response: ServerResponse) => {
        request.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 0,
            model: "deepseek-v4-flash",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Partial answer" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        // Comment-only keep-alives, like OpenRouter's `: PROCESSING`.
        const keepAlive = setInterval(() => {
          response.write(": PROCESSING\n\n");
        }, 50);
        response.on("close", () => {
          clearInterval(keepAlive);
          upstreamClosed = true;
        });
      });
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const { port } = upstream.address() as AddressInfo;
      upstreamUrl = `http://127.0.0.1:${port}/v1`;
    });

    afterEach(async () => {
      config.chat.modelStreamIdleTimeoutMs = originalIdleTimeoutMs;
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });

    test("ends the turn with a retryable stall error and keeps the partial reply", async () => {
      useModel(createOpenAICompatibleModel(upstreamUrl));

      const chunks = await sendTurn("Answer slowly");

      const errors = chunks
        .filter((chunk) => chunk.type === "error")
        .map((chunk) => JSON.parse(String(chunk.errorText)));
      expect(errors).toEqual([
        expect.objectContaining({
          code: ChatErrorCode.UpstreamStalled,
          isRetryable: true,
        }),
      ]);
      await expect.poll(() => upstreamClosed).toBe(true);

      const parts = await persistedAssistantParts();
      expect(parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Partial answer" }),
        ]),
      );
      await expect.poll(runStatus).toBe("failed");
    });
  });

  test("ends the run when the stream stalls after a completed tool call", async () => {
    const originalIdleTimeoutMs = config.chat.modelStreamIdleTimeoutMs;
    config.chat.modelStreamIdleTimeoutMs = 300;
    let toolSignalAborted = false;
    mockGetChatMcpTools.mockResolvedValue({
      read_file: tool({
        description: "Read a file from disk",
        inputSchema: jsonSchema<{ path: string }>({
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        }),
        execute: (_input, { abortSignal }) =>
          new Promise<string>((resolve) => {
            const timer = setTimeout(() => resolve("hello"), 600);
            abortSignal?.addEventListener("abort", () => {
              toolSignalAborted = true;
              clearTimeout(timer);
              resolve("aborted");
            });
          }),
      }),
    });
    let calls = 0;
    useModel(
      new MockLanguageModelV3({
        doStream: async () => {
          calls++;
          return {
            // A completed tool call, then the provider goes silent.
            stream: new ReadableStream<ModelStreamPart>({
              start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "call_1",
                  toolName: "read_file",
                  input: JSON.stringify({ path: "/tmp/a.txt" }),
                });
              },
            }),
          };
        },
      }),
    );

    try {
      const chunks = await sendTurn("Read /tmp/a.txt");

      expect(
        chunks
          .filter((chunk) => chunk.type === "error")
          .map((chunk) => JSON.parse(String(chunk.errorText)).code),
      ).toEqual([ChatErrorCode.UpstreamStalled]);
      expect(toolSignalAborted).toBe(true);
      await expect.poll(runStatus).toBe("failed");
      // Past the tool's own completion time: no follow-up step was started.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(calls).toBe(1);
    } finally {
      config.chat.modelStreamIdleTimeoutMs = originalIdleTimeoutMs;
    }
  });

  test("keeps the previous answer when a regeneration fails before any reply", async () => {
    useModel(
      new MockLanguageModelV3({
        doStream: async () => textReply("Old answer", "stop"),
      }),
    );
    await sendTurn("Question");
    await persistedAssistantParts();
    const [userRow] = (
      await MessageModel.findByConversation(conversationId)
    ).filter((row) => row.role === "user");

    useModel(
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream<ModelStreamPart>({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id: "call_9", toolName: "read_file" },
              { type: "tool-input-delta", id: "call_9", delta: '{"pa' },
              { type: "error", error: new Error("provider exploded") },
            ],
          }),
        }),
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        id: conversationId,
        trigger: "regenerate-message",
        messages: [userRow?.content],
      },
    });
    expect(response.statusCode).toBe(200);
    await expect.poll(runStatus).toBe("failed");

    const assistantTexts = (
      await MessageModel.findByConversation(conversationId)
    )
      .map((row) => row.content as UIMessage)
      .filter((message) => message.role === "assistant")
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        ),
      );
    expect(assistantTexts).toEqual(["Old answer"]);
  });
});

function createOpenAICompatibleModel(baseURL: string) {
  return createOpenAICompatible({
    name: "deepseek",
    apiKey: "test-key",
    baseURL,
  }).chatModel("deepseek-v4-flash");
}
