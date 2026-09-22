import { TOOL_ASK_USER_SHORT_NAME } from "@archestra/shared";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createUIMessageStream,
  simulateReadableStream,
  stepCountIs,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { CacheKey, cacheManager } from "@/cache-manager";
import {
  createChatMcpElicitationBridge,
  resolveChatMcpElicitation,
} from "@/clients/chat-mcp-elicitation";
import { normalizeChatMessagesForPersistence } from "@/routes/chat/normalization/normalize-chat-messages";
import { afterEach, describe, expect, test } from "@/test";
import type { ChatMessage } from "@/types";
import { buildMcpGatewayTool, type ChatToolContext } from "./chat-tool-builder";
import mcpClient from "./mcp-client";
import { ToolCallRepeatTracker } from "./tool-call-repeat-tracker";

// The canonical Map-backed fake from src/__mocks__/cache-manager.ts: the
// shared cache every replica reads, with real get/set/getAndDelete semantics.
vi.mock("@/cache-manager");

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_CONVERSATION_ID = "00000000-0000-4000-8000-000000000002";
const TEN_MINUTES_MS = 10 * 60 * 1000;

describe("chat MCP elicitation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("shows the question with its tool call and tab label, and wakes the waiter as soon as it is answered", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
    });
    bridge.setWriter(stream.writer);

    const outcome = trackSettled(
      bridge.elicit({
        toolName: "archestra__ask_user",
        message: "Who can see it?",
        requestedSchema: { type: "object" },
        toolCallId: "call_visibility",
        header: "Visibility",
      }),
    );
    await flush();

    const [question] = stream.questions();
    expect(question).toMatchObject({
      conversationId: CONVERSATION_ID,
      toolName: "archestra__ask_user",
      message: "Who can see it?",
      mode: "form",
      toolCallId: "call_visibility",
      header: "Visibility",
    });

    await expect(
      resolveChatMcpElicitation({
        id: question.id,
        response: {
          conversationId: CONVERSATION_ID,
          action: "accept",
          content: { choice: "Team" },
        },
      }),
    ).resolves.toBe(true);
    // No clock movement: the answer route woke the waiter in-process instead
    // of leaving it to the next poll.
    await flush();

    expect(outcome.settled).toBe(true);
    await expect(outcome.promise).resolves.toEqual({
      status: "answered",
      result: { action: "accept", content: { choice: "Team" } },
    });
    expect(stream.resolutions()).toEqual([
      { id: question.id, conversationId: CONVERSATION_ID, outcome: "answered" },
    ]);
  });

  test("picks up an answer stored by another replica within a second", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
    });
    bridge.setWriter(stream.writer);

    const handler = bridge.createHandler({
      toolName: "example__create_issue",
      toolCallId: "call_issue",
    });
    const result = trackSettled(
      Promise.resolve(
        handler(
          {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Create an issue?",
              requestedSchema: {
                type: "object",
                properties: { project: { type: "string" } },
              },
            },
          } as ElicitRequest,
          {} as never,
        ),
      ),
    );
    await flush();
    const [question] = stream.questions();
    expect(question).toMatchObject({
      toolName: "example__create_issue",
      toolCallId: "call_issue",
    });

    // The waiter backs off to its ceiling (polls at 0, 250, 750, 1750 ms)...
    await vi.advanceTimersByTimeAsync(1_800);
    // ...when the answer route on another replica claims the question and
    // stores the answer. Nothing wakes this process; only the poll finds it.
    await cacheManager.getAndDelete(
      `chat-mcp-elicitation-pending-${question.id}`,
    );
    await cacheManager.set(`chat-mcp-elicitation-${question.id}`, {
      conversationId: CONVERSATION_ID,
      action: "accept",
      content: { project: "alpha" },
    });

    await vi.advanceTimersByTimeAsync(949);
    expect(result.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result.promise).resolves.toEqual({
      action: "accept",
      content: { project: "alpha" },
    });
  });

  test("accepts exactly one answer, only from the question's own conversation", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
    });
    bridge.setWriter(stream.writer);
    const outcome = bridge.elicit({
      toolName: "archestra__ask_user",
      message: "Pick one",
    });
    await flush();
    const [question] = stream.questions();

    await expect(
      resolveChatMcpElicitation({
        id: "00000000-0000-4000-8000-00000000dead",
        response: { conversationId: CONVERSATION_ID, action: "decline" },
      }),
    ).resolves.toBe(false);
    // An answer from another conversation neither lands nor uses the question up.
    await expect(
      resolveChatMcpElicitation({
        id: question.id,
        response: { conversationId: OTHER_CONVERSATION_ID, action: "decline" },
      }),
    ).resolves.toBe(false);
    await expect(
      resolveChatMcpElicitation({
        id: question.id,
        response: { conversationId: CONVERSATION_ID, action: "decline" },
      }),
    ).resolves.toBe(true);
    await expect(
      resolveChatMcpElicitation({
        id: question.id,
        response: {
          conversationId: CONVERSATION_ID,
          action: "accept",
          content: { choice: "A" },
        },
      }),
    ).resolves.toBe(false);

    await flush();
    await expect(outcome).resolves.toEqual({
      status: "answered",
      result: { action: "decline" },
    });
  });

  test("returns unanswered when nobody answers in time, and refuses a late answer", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
    });
    bridge.setWriter(stream.writer);

    const outcome = bridge.elicit({
      toolName: "archestra__ask_user",
      message: "Accept this change for the rest of this session?",
    });
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS + 1_000);

    await expect(outcome).resolves.toEqual({ status: "unanswered" });
    const [question] = stream.questions();
    expect(stream.resolutions()).toEqual([
      {
        id: question.id,
        conversationId: CONVERSATION_ID,
        outcome: "unanswered",
      },
    ]);
    await expect(
      resolveChatMcpElicitation({
        id: question.id,
        response: { conversationId: CONVERSATION_ID, action: "decline" },
      }),
    ).resolves.toBe(false);
  });

  test("propagates a failed response-cache read instead of reporting unanswered", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
    });
    bridge.setWriter(stream.writer);
    const cacheFailure = new Error("cache unavailable");
    const getAndDelete = vi
      .spyOn(cacheManager, "getAndDelete")
      .mockImplementation(async (key, options?: { throwOnError?: boolean }) => {
        if (
          key.startsWith(`${CacheKey.ChatMcpElicitation}-`) &&
          options?.throwOnError
        ) {
          throw cacheFailure;
        }
        return undefined;
      });

    try {
      const outcome = bridge.elicit({
        toolName: "archestra__ask_user",
        message: "Pick one",
      });
      const rejection = expect(outcome).rejects.toBe(cacheFailure);

      // Without strict reads, this instead waits through the deadline and
      // reports an unanswered question.
      await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS + 6_000);
      await rejection;
    } finally {
      getAndDelete.mockRestore();
    }
  });

  test("propagates a failed deadline cleanup instead of reporting unanswered", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
    });
    bridge.setWriter(stream.writer);
    const cacheFailure = new Error("cache unavailable");
    const getAndDelete = vi
      .spyOn(cacheManager, "getAndDelete")
      .mockImplementation(async (key, options?: { throwOnError?: boolean }) => {
        if (
          key.startsWith(`${CacheKey.ChatMcpElicitationPending}-`) &&
          options?.throwOnError
        ) {
          throw cacheFailure;
        }
        return undefined;
      });

    try {
      const outcome = bridge.elicit({
        toolName: "archestra__ask_user",
        message: "Pick one",
      });
      const rejection = expect(outcome).rejects.toBe(cacheFailure);

      // A non-strict pending-marker read turns this cache failure into the
      // ordinary deadline path and its answer grace period.
      await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS + 6_000);
      await rejection;
    } finally {
      getAndDelete.mockRestore();
    }
  });

  test("still delivers an answer the route claimed right at the deadline", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
    });
    bridge.setWriter(stream.writer);
    const outcome = bridge.elicit({
      toolName: "archestra__ask_user",
      message: "Pick one",
    });
    await flush();
    const [question] = stream.questions();

    // The route claims the question a moment before the deadline, but its
    // answer only lands after the waiter's last regular poll.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES_MS - 100);
    await cacheManager.getAndDelete(
      `chat-mcp-elicitation-pending-${question.id}`,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await cacheManager.set(`chat-mcp-elicitation-${question.id}`, {
      conversationId: CONVERSATION_ID,
      action: "accept",
      content: { choice: "A" },
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(outcome).resolves.toEqual({
      status: "answered",
      result: { action: "accept", content: { choice: "A" } },
    });
  });

  test("stops waiting as soon as the chat stream aborts, and withdraws the question", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const abortController = new AbortController();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
      abortSignal: abortController.signal,
    });
    bridge.setWriter(stream.writer);

    const outcome = bridge.elicit({
      toolName: "archestra__ask_user",
      message: "Pick one",
    });
    const rejection = expect(outcome).rejects.toThrow(
      "MCP elicitation cancelled because chat stream stopped",
    );
    await flush();
    const [question] = stream.questions();

    abortController.abort();
    await rejection;

    expect(stream.resolutions()).toEqual([
      {
        id: question.id,
        conversationId: CONVERSATION_ID,
        outcome: "cancelled",
      },
    ]);
    await expect(
      resolveChatMcpElicitation({
        id: question.id,
        response: { conversationId: CONVERSATION_ID, action: "decline" },
      }),
    ).resolves.toBe(false);
  });

  test("fails closed when a cancelled question cannot be withdrawn", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const abortController = new AbortController();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
      abortSignal: abortController.signal,
    });
    bridge.setWriter(stream.writer);
    const deleteError = new Error("Shared cache unavailable");
    vi.spyOn(cacheManager, "delete").mockRejectedValueOnce(deleteError);

    const outcome = bridge.elicit({
      toolName: "archestra__ask_user",
      message: "Pick one",
    });
    await flush();
    abortController.abort();

    await expect(outcome).rejects.toThrow(deleteError);
    expect(stream.resolutions()).toEqual([]);
  });

  test("withdraws an upstream server's question as soon as that server gives up on it", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
      abortSignal: new AbortController().signal,
    });
    bridge.setWriter(stream.writer);
    // The request's own signal, which the MCP SDK aborts when the server
    // cancels the request, it times out, or the transport closes.
    const upstream = new AbortController();

    const handler = bridge.createHandler({
      toolName: "example__create_issue",
      toolCallId: "call_issue",
    });
    const result = Promise.resolve(
      handler(
        {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Create an issue?",
            requestedSchema: { type: "object", properties: {} },
          },
        } as ElicitRequest,
        { signal: upstream.signal } as never,
      ),
    );
    const rejection = expect(result).rejects.toThrow(
      "MCP elicitation cancelled",
    );
    await flush();
    const [question] = stream.questions();

    upstream.abort();
    await rejection;

    expect(stream.resolutions()).toEqual([
      {
        id: question.id,
        conversationId: CONVERSATION_ID,
        outcome: "cancelled",
      },
    ]);
    await expect(
      resolveChatMcpElicitation({
        id: question.id,
        response: { conversationId: CONVERSATION_ID, action: "decline" },
      }),
    ).resolves.toBe(false);
  });

  test("hands a question back when its answer fails to store, so a retry still lands", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
    });
    bridge.setWriter(stream.writer);
    const outcome = bridge.elicit({
      toolName: "archestra__ask_user",
      message: "Pick one",
    });
    await flush();
    const [question] = stream.questions();
    const answer = {
      id: question.id,
      response: {
        conversationId: CONVERSATION_ID,
        action: "accept" as const,
        content: { choice: "A" },
      },
    };

    // The shared cache fails the write that would store the answer.
    const set = vi
      .spyOn(cacheManager, "set")
      .mockRejectedValueOnce(new Error("cache unavailable"));
    try {
      await expect(resolveChatMcpElicitation(answer)).rejects.toThrow(
        "cache unavailable",
      );
    } finally {
      set.mockRestore();
    }

    await expect(resolveChatMcpElicitation(answer)).resolves.toBe(true);
    await flush();
    await expect(outcome).resolves.toEqual({
      status: "answered",
      result: { action: "accept", content: { choice: "A" } },
    });
  });

  test("ties an upstream server's question to the chat tool call that raised it", async ({
    makeAgent,
    makeUser,
    makeConversation,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: agent.organizationId,
    });
    const bridge = createChatMcpElicitationBridge({
      conversationId: conversation.id,
    });
    const questions: Array<{ toolName: string; toolCallId?: string }> = [];
    bridge.setWriter({
      write: (chunk) => {
        if (chunk.type !== "data-mcp-elicitation") return;
        const question = chunk.data as {
          id: string;
          toolName: string;
          toolCallId?: string;
        };
        questions.push(question);
        void resolveChatMcpElicitation({
          id: question.id,
          response: {
            conversationId: conversation.id,
            action: "accept",
            content: { project: "alpha" },
          },
        });
      },
    });
    // The upstream MCP server, which asks its question mid-call.
    const upstream = vi
      .spyOn(mcpClient, "executeToolCallForOwner")
      .mockImplementation(async (toolCall, _owner, _auth, options) => {
        const answer = await options?.elicitationHandler?.(
          {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Which project?",
              requestedSchema: {
                type: "object",
                properties: { project: { type: "string" } },
              },
            },
          } as ElicitRequest,
          { signal: new AbortController().signal } as never,
        );
        return {
          id: toolCall.id,
          name: toolCall.name,
          content: [
            { type: "text", text: `Created in ${answer?.content?.project}` },
          ],
          isError: false,
        };
      });
    const tool = buildMcpGatewayTool({
      mcpTool: {
        name: "example__create_issue",
        inputSchema: { type: "object" },
      },
      ctx: {
        organizationId: agent.organizationId,
        userId: user.id,
        conversationId: conversation.id,
        sessionId: conversation.id,
        agentId: agent.id,
        agentName: agent.name,
        elicitation: bridge,
        repeatTracker: new ToolCallRepeatTracker(),
      } as ChatToolContext,
    });

    try {
      const output = await tool.execute?.({ title: "Broken build" }, {
        toolCallId: "call_issue",
        messages: [],
      } as never);

      expect(questions).toMatchObject([
        { toolName: "example__create_issue", toolCallId: "call_issue" },
      ]);
      expect(JSON.stringify(output)).toContain("Created in alpha");
    } finally {
      upstream.mockRestore();
    }
  });

  test("questions raised in parallel wait and resolve independently, in any order", async () => {
    vi.useFakeTimers();
    const stream = recordStream();
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
    });
    bridge.setWriter(stream.writer);

    const first = trackSettled(
      bridge.elicit({
        toolName: "archestra__ask_user",
        message: "Who can see it?",
        toolCallId: "call_visibility",
        header: "Visibility",
      }),
    );
    const second = trackSettled(
      bridge.elicit({
        toolName: "archestra__ask_user",
        message: "Where should it run?",
        toolCallId: "call_region",
        header: "Region",
      }),
    );
    await flush();
    const questions = stream.questions();
    expect(questions.map((question) => question.toolCallId)).toEqual([
      "call_visibility",
      "call_region",
    ]);
    const [visibility, region] = questions;

    await resolveChatMcpElicitation({
      id: region.id,
      response: {
        conversationId: CONVERSATION_ID,
        action: "accept",
        content: { choice: "EU" },
      },
    });
    await flush();
    expect(second.settled).toBe(true);
    expect(first.settled).toBe(false);

    await resolveChatMcpElicitation({
      id: visibility.id,
      response: {
        conversationId: CONVERSATION_ID,
        action: "accept",
        content: { choice: "Team" },
      },
    });
    await flush();

    await expect(first.promise).resolves.toEqual({
      status: "answered",
      result: { action: "accept", content: { choice: "Team" } },
    });
    await expect(second.promise).resolves.toEqual({
      status: "answered",
      result: { action: "accept", content: { choice: "EU" } },
    });
    expect(stream.resolutions().map((resolution) => resolution.id)).toEqual([
      region.id,
      visibility.id,
    ]);
  });

  test("only a built-in elicit() request carries a rendering kind", async () => {
    const getAndDeleteSpy = vi
      .spyOn(cacheManager, "getAndDelete")
      .mockResolvedValue(undefined);
    try {
      const writer = { write: vi.fn() };
      const abortController = new AbortController();
      const bridge = createChatMcpElicitationBridge({
        conversationId: "00000000-0000-4000-8000-000000000001",
        abortSignal: abortController.signal,
      });
      bridge.setWriter(writer);

      const review = bridge.elicit({
        toolName: "execute_remedy_plan",
        message: "Tool: archestra__todo_write",
        kind: "openappa_review",
        reviewedTool: "archestra__todo_write",
        reviewedArguments: '{"todos":[]}',
      });
      // A server cannot ask for the approval card by naming the kind itself.
      const thirdParty = bridge.createHandler({
        toolName: "example__execute_remedy_plan",
      })(
        {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Approve?",
            requestedSchema: { type: "object", properties: {} },
            kind: "openappa_review",
          },
        } as ElicitRequest,
        {} as never,
      );

      // Stop both waits even when an assertion fails, so no poll outlives the test.
      const settled = Promise.allSettled([review, thirdParty]);
      try {
        // Let both requests reach the stream before asserting their chunks.
        await new Promise((resolve) => setImmediate(resolve));
        const chunks = writer.write.mock.calls.map(([chunk]) => chunk.data);
        expect(chunks).toEqual([
          expect.objectContaining({
            toolName: "execute_remedy_plan",
            kind: "openappa_review",
            reviewedTool: "archestra__todo_write",
            reviewedArguments: '{"todos":[]}',
          }),
          expect.objectContaining({ toolName: "example__execute_remedy_plan" }),
        ]);
        expect(chunks[1].kind).toBeUndefined();
      } finally {
        abortController.abort();
        await settled;
      }
    } finally {
      getAndDeleteSpy.mockRestore();
    }
  });

  test("elicit() returns no_viewer when no chat stream writer is attached", async () => {
    const bridge = createChatMcpElicitationBridge({
      conversationId: CONVERSATION_ID,
    });

    await expect(
      bridge.elicit({ toolName: "archestra__refine_app", message: "Hi?" }),
    ).resolves.toEqual({ status: "no_viewer" });
  });

  test("parallel ask_user calls in one model step each raise a card and persist the user's answer", async ({
    makeAgent,
    makeUser,
    makeConversation,
  }) => {
    const user = await makeUser();
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: agent.organizationId,
    });
    const askUser = archestraMcpBranding.getToolName(TOOL_ASK_USER_SHORT_NAME);
    const bridge = createChatMcpElicitationBridge({
      conversationId: conversation.id,
    });
    const tool = buildMcpGatewayTool({
      mcpTool: { name: askUser, inputSchema: { type: "object" } },
      ctx: {
        organizationId: agent.organizationId,
        userId: user.id,
        conversationId: conversation.id,
        sessionId: conversation.id,
        agentId: agent.id,
        agentName: agent.name,
        elicitation: bridge,
        repeatTracker: new ToolCallRepeatTracker(),
      } as ChatToolContext,
    });
    const model = modelAskingInParallel(askUser, [
      {
        toolCallId: "call_visibility",
        question: "Who can see it?",
        header: "Visibility",
        options: ["Team", "Organization"],
      },
      {
        toolCallId: "call_region",
        question: "Where should it run?",
        header: "Region",
        options: ["EU", "US"],
      },
    ]);

    let responseMessage: UIMessage | undefined;
    const uiStream = createUIMessageStream({
      execute: ({ writer }) => {
        bridge.setWriter(writer);
        writer.merge(
          streamText({
            model,
            tools: { [askUser]: tool },
            prompt: "Set up the service.",
            stopWhen: stepCountIs(2),
          }).toUIMessageStream(),
        );
      },
      onFinish: ({ responseMessage: message }) => {
        responseMessage = message;
      },
    });

    const questions: Array<{ id: string; toolCallId?: string }> = [];
    const resolvedIds: string[] = [];
    const answer = (id: string, choice: string) =>
      resolveChatMcpElicitation({
        id,
        response: {
          conversationId: conversation.id,
          action: "accept",
          content: { choice },
        },
      });
    for await (const chunk of uiStream) {
      if (chunk.type === "data-mcp-elicitation") {
        questions.push(chunk.data as { id: string; toolCallId?: string });
        // Both questions are up before either is answered; answer the
        // second one first.
        if (questions.length === 2) {
          await answer(questionFor(questions, "call_region").id, "EU");
        }
      }
      if (chunk.type === "data-mcp-elicitation-resolved") {
        const { id } = chunk.data as { id: string };
        resolvedIds.push(id);
        if (resolvedIds.length === 1) {
          await answer(questionFor(questions, "call_visibility").id, "Team");
        }
      }
    }

    expect(resolvedIds).toEqual([
      questionFor(questions, "call_region").id,
      questionFor(questions, "call_visibility").id,
    ]);
    const [persisted] = normalizeChatMessagesForPersistence([
      responseMessage as ChatMessage,
    ]);
    expect(askUserAnswers(persisted)).toEqual({
      call_visibility: { action: "accept", selected: ["Team"] },
      call_region: { action: "accept", selected: ["EU"] },
    });
  });
});

// === Helpers ===

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

function recordStream() {
  const chunks: UIMessageChunk[] = [];
  const dataOf = <T>(type: string) =>
    chunks.flatMap((chunk) =>
      chunk.type === type ? [(chunk as { data: T }).data] : [],
    );
  return {
    writer: { write: (chunk: UIMessageChunk) => chunks.push(chunk) },
    questions: () =>
      dataOf<{ id: string; toolCallId?: string; header?: string }>(
        "data-mcp-elicitation",
      ),
    resolutions: () =>
      dataOf<{ id: string; conversationId: string; outcome: string }>(
        "data-mcp-elicitation-resolved",
      ),
  };
}

function trackSettled<T>(promise: Promise<T>) {
  const tracked = { promise, settled: false };
  promise.then(
    () => {
      tracked.settled = true;
    },
    () => {
      tracked.settled = true;
    },
  );
  return tracked;
}

function questionFor(
  questions: Array<{ id: string; toolCallId?: string }>,
  toolCallId: string,
) {
  const question = questions.find((entry) => entry.toolCallId === toolCallId);
  if (!question) {
    throw new Error(`No question was raised for ${toolCallId}`);
  }
  return question;
}

function modelAskingInParallel(
  toolName: string,
  calls: Array<{
    toolCallId: string;
    question: string;
    header: string;
    options: string[];
  }>,
) {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const askingStep = [
    { type: "stream-start" as const, warnings: [] },
    ...calls.map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.toolCallId,
      toolName,
      input: JSON.stringify({
        question: call.question,
        header: call.header,
        options: call.options.map((label) => ({ label })),
      }),
    })),
    {
      type: "finish" as const,
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage,
    },
  ];
  const answeringStep = [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "1" },
    { type: "text-delta" as const, id: "1", delta: "Done." },
    { type: "text-end" as const, id: "1" },
    {
      type: "finish" as const,
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage,
    },
  ];
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream:
        step++ === 0
          ? simulateReadableStream({ chunks: askingStep })
          : simulateReadableStream({ chunks: answeringStep }),
    }),
  });
}

function askUserAnswers(message: ChatMessage | undefined) {
  return Object.fromEntries(
    (message?.parts ?? []).flatMap((part) => {
      const toolPart = part as {
        type: string;
        toolCallId?: string;
        output?: { structuredContent?: unknown };
      };
      return toolPart.type.startsWith("tool-") && toolPart.toolCallId
        ? [[toolPart.toolCallId, toolPart.output?.structuredContent]]
        : [];
    }),
  );
}
