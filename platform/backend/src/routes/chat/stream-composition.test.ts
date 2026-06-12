import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { MessageModel, SkillModel } from "@/models";
import ConversationAttachmentModel from "@/models/conversation-attachment";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { activeChatRunService } from "@/services/active-chat-run";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// Characterization tests for the POST /api/chat handler's composition: the
// ordering and wiring between the (individually unit-tested) helpers. These pin
// behavior that only exists at the handler level — injection-before-
// normalization, compaction event emission, pre-merge persistence, probe
// iterator handling, and tool-UI chunk placement.

const mockCreateUIMessageStream = vi.hoisted(() => vi.fn());
const mockCreateUIMessageStreamResponse = vi.hoisted(() => vi.fn());
const mockStreamText = vi.hoisted(() => vi.fn());
const mockCreateLLMModelForAgent = vi.hoisted(() => vi.fn());
const mockGetChatMcpTools = vi.hoisted(() => vi.fn());
const mockGetChatMcpToolUiResourceUris = vi.hoisted(() => vi.fn());
const mockFetchToolUiResource = vi.hoisted(() => vi.fn());
const mockExtractAndIngestDocuments = vi.hoisted(() => vi.fn());
const mockStartActiveChatSpan = vi.hoisted(() => vi.fn());
const mockCompactMessagesForChat = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    createUIMessageStream: mockCreateUIMessageStream,
    createUIMessageStreamResponse: mockCreateUIMessageStreamResponse,
    streamText: mockStreamText,
    convertToModelMessages: vi.fn(async (messages) => messages),
  };
});

vi.mock("@/clients/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/llm-client")>();
  return {
    ...actual,
    createLLMModelForAgent: mockCreateLLMModelForAgent,
  };
});

vi.mock("@/clients/chat-mcp-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/clients/chat-mcp-client")>();
  return {
    ...actual,
    getChatMcpTools: mockGetChatMcpTools,
    getChatMcpToolUiResourceUris: mockGetChatMcpToolUiResourceUris,
    fetchToolUiResource: mockFetchToolUiResource,
  };
});

vi.mock("@/knowledge-base", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/knowledge-base")>();
  return {
    ...actual,
    extractAndIngestDocuments: mockExtractAndIngestDocuments,
  };
});

vi.mock("@/observability/tracing", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/observability/tracing")>();
  return {
    ...actual,
    startActiveChatSpan: mockStartActiveChatSpan,
  };
});

vi.mock("./context-compaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context-compaction")>();
  return {
    ...actual,
    compactMessagesForChat: mockCompactMessagesForChat,
  };
});

type StreamWriter = {
  write: (chunk: unknown) => void;
  merge: (stream: ReadableStream<unknown>) => void;
};

const RENDERABLE_STREAM_EVENTS = [
  { type: "text-delta", text: "hi" },
  { type: "finish", finishReason: "stop" },
];
const EMPTY_STREAM_EVENTS = [
  { type: "start" },
  { type: "finish", finishReason: "stop" },
];

// streamText result whose fullStream yields the given events and records
// whether the probe ever cancelled the iterator via return().
function fakeStreamResult(
  events: Array<Record<string, unknown>>,
  options?: { uiChunks?: Array<Record<string, unknown>> },
) {
  const state = { returnCalled: false };
  return {
    state,
    fullStream: {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async () =>
            index < events.length
              ? { done: false, value: events[index++] }
              : { done: true, value: undefined },
          return: async () => {
            state.returnCalled = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    },
    toUIMessageStream: () =>
      new ReadableStream({
        start(controller) {
          for (const chunk of options?.uiChunks ?? []) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
    usage: Promise.resolve(null),
  };
}

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

describe("POST /api/chat handler composition", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let conversationId: string;
  let executionPromise: Promise<void> | undefined;
  let capturedOuterErrorPayload: string | undefined;
  let writerEvents: Array<{ kind: "write" | "merge"; value: unknown }>;
  let mergedStreams: ReadableStream<unknown>[];
  let runExecute = true;

  beforeEach(
    async ({ makeAgent, makeConversation, makeOrganization, makeUser }) => {
      executionPromise = undefined;
      capturedOuterErrorPayload = undefined;
      writerEvents = [];
      mergedStreams = [];
      runExecute = true;

      user = await makeUser();
      const organization = await makeOrganization({ name: "Test Org" });
      organizationId = organization.id;
      const agent = await makeAgent({
        organizationId,
        name: "Router Agent",
        systemPrompt: "",
      });
      const conversation = await makeConversation(agent.id, {
        userId: user.id,
        organizationId,
      });
      conversationId = conversation.id;

      mockCreateLLMModelForAgent.mockResolvedValue({ model: "mock-model" });
      mockGetChatMcpTools.mockResolvedValue({});
      mockGetChatMcpToolUiResourceUris.mockResolvedValue({});
      mockFetchToolUiResource.mockResolvedValue(null);
      mockExtractAndIngestDocuments.mockResolvedValue(undefined);
      mockCompactMessagesForChat.mockImplementation(
        async ({ messages }: { messages: unknown[] }) => ({
          messages,
          status: "skipped",
          compaction: null,
          reason: "below_threshold",
        }),
      );
      mockStartActiveChatSpan.mockImplementation(
        async ({ callback }: { callback: () => Promise<Response> }) =>
          callback(),
      );
      mockStreamText.mockImplementation(() =>
        fakeStreamResult(RENDERABLE_STREAM_EVENTS),
      );

      mockCreateUIMessageStream.mockImplementation(
        ({
          execute,
          onError,
        }: {
          execute: (args: { writer: StreamWriter }) => Promise<void>;
          onError: (error: unknown) => string;
        }) => {
          if (runExecute) {
            const writer: StreamWriter = {
              write: (chunk) =>
                writerEvents.push({ kind: "write", value: chunk }),
              merge: (stream) => {
                writerEvents.push({ kind: "merge", value: stream });
                mergedStreams.push(stream);
              },
            };
            // route the pre-merge throw (exhausted empty response) to onError,
            // mirroring how createUIMessageStream surfaces an execute() rejection.
            executionPromise = execute({ writer }).catch((error) => {
              capturedOuterErrorPayload = onError(error);
            });
          }
          return new ReadableStream({
            start(controller) {
              controller.close();
            },
          });
        },
      );
      mockCreateUIMessageStreamResponse.mockImplementation(
        ({ stream }: { stream: ReadableStream }) =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/plain" },
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

  async function postMessage(payloadMessages: unknown[]) {
    return app.inject({
      method: "POST",
      url: "/api/chat",
      payload: { id: conversationId, messages: payloadMessages },
    });
  }

  const plainUserMessage = (text: string) => [
    { id: "msg-1", role: "user", parts: [{ type: "text", text }] },
  ];

  test("injects slash-command skill activation into the model-bound messages but not the persisted ones", async ({
    makeMember,
  }) => {
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    const { default: OrganizationModel } = await import(
      "@/models/organization"
    );
    await OrganizationModel.patch(organizationId, {
      skillSlashCommandsEnabled: true,
      skillToolsEnabled: true,
    });
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: "pdf-processing",
        description: "Extract text from PDF files.",
        content: "# PDF Processing\nUse pdftotext.",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    if (!skill) {
      throw new Error("Failed to create test skill");
    }

    const response = await postMessage([
      {
        id: "msg-1",
        role: "user",
        parts: [{ type: "text", text: "extract the attached pdf" }],
        metadata: { skill: { id: skill.id, name: skill.name } },
      },
    ]);
    expect(response.statusCode).toBe(200);
    await executionPromise;

    // The injected activation block must survive the rest of the message
    // preparation (normalization and the compaction pass-through; conversion
    // is identity-mocked here) and reach streamText prepended to the user's
    // text.
    expect(mockStreamText).toHaveBeenCalledTimes(1);
    const sentMessages = mockStreamText.mock.calls[0]?.[0].messages as Array<{
      role: string;
      parts?: Array<{ type: string; text?: string }>;
    }>;
    const sentUserText = sentMessages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    expect(sentUserText).toContain("# PDF Processing");
    expect(sentUserText).toContain("extract the attached pdf");

    // The persisted user message stays clean: injection works on a copy.
    const persisted = await MessageModel.findByConversation(conversationId);
    const persistedUser = persisted.find((m) => m.role === "user");
    expect(persistedUser).toBeDefined();
    expect(JSON.stringify(persistedUser?.content)).not.toContain(
      "# PDF Processing",
    );
  });

  test("emits compaction start/finish and context-window-estimate events in order, before the stream merge", async () => {
    mockCompactMessagesForChat.mockImplementation(
      async ({
        messages,
        onCompactionStart,
      }: {
        messages: unknown[];
        onCompactionStart: () => void;
      }) => {
        onCompactionStart();
        return {
          messages,
          status: "created",
          compaction: {
            id: "compaction-1",
            trigger: "auto",
            originalTokenEstimate: 120_000,
            compactedTokenEstimate: 2_000,
          },
          inputTokenEstimate: 2_000,
        };
      },
    );

    const response = await postMessage(plainUserMessage("hello"));
    expect(response.statusCode).toBe(200);
    await executionPromise;

    const eventOrder = writerEvents.map((event) =>
      event.kind === "merge" ? "merge" : (event.value as { type: string }).type,
    );
    const startIndex = eventOrder.indexOf("data-context-compaction-start");
    const finishIndex = eventOrder.indexOf("data-context-compaction-finish");
    const estimateIndex = eventOrder.indexOf("data-context-window-estimate");
    const mergeIndex = eventOrder.indexOf("merge");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(finishIndex).toBeGreaterThan(startIndex);
    expect(estimateIndex).toBeGreaterThan(finishIndex);
    expect(mergeIndex).toBeGreaterThan(estimateIndex);

    const finishEvent = writerEvents[finishIndex]?.value as {
      data: { status: string };
    };
    expect(finishEvent.data).toMatchObject({ status: "created" });
    const estimateEvent = writerEvents[estimateIndex]?.value as {
      data: { estimatedTokens: number };
    };
    expect(estimateEvent.data.estimatedTokens).toBe(2_000);
  });

  test("persists the user message even when empty-response retries exhaust before the merge", async () => {
    mockStreamText.mockImplementation(() =>
      fakeStreamResult(EMPTY_STREAM_EVENTS),
    );

    const response = await postMessage(plainUserMessage("hello empty"));
    expect(response.statusCode).toBe(200);
    await executionPromise;

    expect(capturedOuterErrorPayload).toBeDefined();
    expect(writerEvents.filter((e) => e.kind === "merge")).toHaveLength(0);
    const persisted = await MessageModel.findByConversation(conversationId);
    const persistedUser = persisted.find((m) => m.role === "user");
    expect(persistedUser).toBeDefined();
    expect(JSON.stringify(persistedUser?.content)).toContain("hello empty");
  });

  test("probes the stream without cancelling its iterator, then merges the same result", async () => {
    const result = fakeStreamResult(RENDERABLE_STREAM_EVENTS);
    mockStreamText.mockImplementation(() => result);

    const response = await postMessage(plainUserMessage("hello"));
    expect(response.statusCode).toBe(200);
    await executionPromise;

    // The probe peeks the fullStream iterator; cancelling it (e.g. via a
    // for-await rewrite) would drop the SDK result's internal tee and break
    // the merge that follows.
    expect(result.state.returnCalled).toBe(false);
    expect(writerEvents.filter((e) => e.kind === "merge")).toHaveLength(1);
  });

  test("emits data-tool-ui-start inside the merged stream right after tool-input-start, never via writer.write", async () => {
    mockGetChatMcpToolUiResourceUris.mockResolvedValue({
      my_app_tool: "ui://my-app/main",
    });
    mockFetchToolUiResource.mockResolvedValue({ html: "<div>app</div>" });
    mockStreamText.mockImplementation(() =>
      fakeStreamResult(RENDERABLE_STREAM_EVENTS, {
        uiChunks: [
          { type: "start" },
          {
            type: "tool-input-start",
            toolCallId: "call-1",
            toolName: "my_app_tool",
          },
          { type: "tool-input-delta", toolCallId: "call-1", delta: "{}" },
          { type: "finish" },
        ],
      }),
    );

    const response = await postMessage(plainUserMessage("open the app"));
    expect(response.statusCode).toBe(200);
    await executionPromise;

    expect(mergedStreams).toHaveLength(1);
    const mergedChunks = (await readAll(mergedStreams[0])) as Array<{
      type: string;
    }>;
    const toolStartIndex = mergedChunks.findIndex(
      (chunk) => chunk.type === "tool-input-start",
    );
    expect(toolStartIndex).toBeGreaterThanOrEqual(0);
    expect(mergedChunks[toolStartIndex + 1]).toMatchObject({
      type: "data-tool-ui-start",
      data: {
        toolCallId: "call-1",
        toolName: "my_app_tool",
        uiResourceUri: "ui://my-app/main",
        html: "<div>app</div>",
      },
    });

    // Placement is the contract: the UI-start chunk rides the merged stream
    // (after the probe), not the writer, so the probe can never emit it early.
    const directWrites = writerEvents
      .filter((e) => e.kind === "write")
      .map((e) => (e.value as { type: string }).type);
    expect(directWrites).not.toContain("data-tool-ui-start");
  });

  test("persists the user message before the stream executes", async () => {
    runExecute = false;

    const response = await postMessage(plainUserMessage("persist me early"));
    expect(response.statusCode).toBe(200);

    // execute() never ran, so the only persistence opportunity was the early
    // pre-stream persist. A reload during streaming depends on this.
    const persisted = await MessageModel.findByConversation(conversationId);
    const persistedUser = persisted.find((m) => m.role === "user");
    expect(persistedUser).toBeDefined();
    expect(JSON.stringify(persistedUser?.content)).toContain(
      "persist me early",
    );
  });

  test("does not extract inline attachments when the conversation already has an active run", async () => {
    const blockingRun = await activeChatRunService.createRun({
      conversationId,
      userId: user.id,
      organizationId,
    });
    expect(blockingRun).not.toBeNull();

    const dataUrl = `data:text/plain;base64,${Buffer.from("attachment-bytes").toString("base64")}`;
    const response = await postMessage([
      {
        id: "msg-1",
        role: "user",
        parts: [
          { type: "text", text: "with attachment" },
          { type: "file", url: dataUrl, filename: "a.txt" },
        ],
      },
    ]);

    expect(response.statusCode).toBe(409);
    const attachments =
      await ConversationAttachmentModel.findByConversationIdWithoutData(
        conversationId,
      );
    expect(attachments).toHaveLength(0);
  });
});
