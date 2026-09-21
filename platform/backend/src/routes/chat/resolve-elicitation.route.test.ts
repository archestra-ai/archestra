import type { UIMessageChunk } from "ai";
import { vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import { createChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  useRouteTestApp,
} from "@/test";
import chatRoutes from "./routes";

// The shared cache the waiter and the answer route meet in, as a Map-backed
// fake with real get/set/getAndDelete semantics.
vi.mock("@/cache-manager");

describe("POST /api/chat/elicitation/:id", () => {
  const ctx = useRouteTestApp(chatRoutes);
  let agentId: string;
  let conversationId: string;
  const streams: AbortController[] = [];

  beforeEach(async ({ makeAgent, makeConversation }) => {
    agentId = (await makeAgent({ organizationId: ctx.organizationId })).id;
    conversationId = (
      await makeConversation(agentId, {
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
      })
    ).id;
  });

  afterEach(() => {
    // Stop any question still waiting, as the chat stream ending would.
    for (const stream of streams.splice(0)) {
      stream.abort();
    }
  });

  const answer = (
    id: string,
    body: {
      conversationId: string;
      action: "accept" | "decline" | "cancel";
      content?: Record<string, string>;
    },
  ) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/chat/elicitation/${id}`,
      payload: body,
    });

  // Asks a question in a conversation the way a chat stream does, and returns
  // the id the chat client answers under.
  async function askQuestion(inConversationId: string) {
    const stream = new AbortController();
    streams.push(stream);
    const chunks: UIMessageChunk[] = [];
    const bridge = createChatMcpElicitationBridge({
      conversationId: inConversationId,
      abortSignal: stream.signal,
    });
    bridge.setWriter({ write: (chunk) => chunks.push(chunk) });
    const outcome = bridge.elicit({
      toolName: "archestra__ask_user",
      message: "Who can see it?",
    });
    // A question still waiting when the test ends is stopped, not failed.
    outcome.catch(() => undefined);
    await vi.waitFor(() =>
      expect(chunks.map((chunk) => chunk.type)).toContain(
        "data-mcp-elicitation",
      ),
    );
    const question = chunks.find(
      (chunk) => chunk.type === "data-mcp-elicitation",
    ) as { data: { id: string } };
    return { id: question.data.id, outcome };
  }

  test("hands the answer to the waiting question, once", async () => {
    const question = await askQuestion(conversationId);

    const response = await answer(question.id, {
      conversationId,
      action: "accept",
      content: { choice: "Team" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    await expect(question.outcome).resolves.toEqual({
      status: "answered",
      result: { action: "accept", content: { choice: "Team" } },
    });

    // Answered already: a second submit (a reloaded card, a double click) is
    // refused instead of stored for nobody.
    const again = await answer(question.id, {
      conversationId,
      action: "accept",
      content: { choice: "Organization" },
    });
    expect(again.statusCode).toBe(409);
  });

  test("refuses an answer to a question nobody is waiting for", async () => {
    const response = await answer(crypto.randomUUID(), {
      conversationId,
      action: "decline",
    });

    expect(response.statusCode).toBe(409);
  });

  test.each([
    "get",
    "getAndDelete",
  ] as const)("keeps the question retryable when the cache %s fails", async (operation) => {
    const question = await askQuestion(conversationId);
    const pendingKey = `${CacheKey.ChatMcpElicitationPending}-${question.id}`;
    const original = cacheManager[operation].bind(cacheManager);
    const cacheOperation = vi
      .spyOn(cacheManager, operation)
      .mockImplementation(async (key, options) => {
        if (key === pendingKey) {
          if (options?.throwOnError) throw new Error("Cache unavailable");
          return undefined;
        }
        return original(key, options);
      });

    const response = await answer(question.id, {
      conversationId,
      action: "accept",
      content: { choice: "Team" },
    });
    expect(response.statusCode).toBe(500);
    cacheOperation.mockRestore();

    const retry = await answer(question.id, {
      conversationId,
      action: "accept",
      content: { choice: "Team" },
    });
    expect(retry.statusCode).toBe(200);
    await expect(question.outcome).resolves.toEqual({
      status: "answered",
      result: { action: "accept", content: { choice: "Team" } },
    });
  });

  test("refuses an answer sent through another of the user's conversations", async ({
    makeConversation,
  }) => {
    const other = await makeConversation(agentId, {
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
    });
    const question = await askQuestion(conversationId);

    const response = await answer(question.id, {
      conversationId: other.id,
      action: "decline",
    });
    expect(response.statusCode).toBe(409);

    // The misdirected answer did not use the question up.
    const own = await answer(question.id, {
      conversationId,
      action: "decline",
    });
    expect(own.statusCode).toBe(200);
    await expect(question.outcome).resolves.toEqual({
      status: "answered",
      result: { action: "decline" },
    });
  });

  test("refuses an answer for a conversation the user does not own", async ({
    makeConversation,
    makeUser,
  }) => {
    const owner = await makeUser();
    const conversation = await makeConversation(agentId, {
      userId: owner.id,
      organizationId: ctx.organizationId,
    });
    const question = await askQuestion(conversation.id);

    const response = await answer(question.id, {
      conversationId: conversation.id,
      action: "decline",
    });

    expect(response.statusCode).toBe(404);
  });
});
