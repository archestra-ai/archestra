import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createChatMcpElicitationBridge,
  resolveChatMcpElicitation,
} from "@/clients/chat-mcp-elicitation";

const cacheManagerMocks = vi.hoisted(() => ({
  getAndDelete: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/cache-manager", () => ({
  CacheKey: { ChatMcpElicitation: "chat-mcp-elicitation" },
  cacheManager: cacheManagerMocks,
}));

describe("chat MCP elicitation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test("writes elicitation requests to the chat stream and returns accepted content", async () => {
    vi.useFakeTimers();
    const writer = { write: vi.fn() };
    const bridge = createChatMcpElicitationBridge({
      conversationId: "00000000-0000-4000-8000-000000000001",
    });
    bridge.setWriter(writer);

    cacheManagerMocks.getAndDelete
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        conversationId: "00000000-0000-4000-8000-000000000001",
        action: "accept",
        content: { project: "alpha", priority: 2 },
      });

    const handler = bridge.createHandler({ toolName: "example__create_issue" });
    const resultPromise = handler(
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
    );

    expect(writer.write).toHaveBeenCalledWith({
      type: "data-mcp-elicitation",
      data: expect.objectContaining({
        conversationId: "00000000-0000-4000-8000-000000000001",
        toolName: "example__create_issue",
        message: "Create an issue?",
        mode: "form",
        requestedSchema: expect.objectContaining({ type: "object" }),
      }),
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(resultPromise).resolves.toEqual({
      action: "accept",
      content: { project: "alpha", priority: 2 },
    });
  });

  test("stores user responses for the pending elicitation id", async () => {
    cacheManagerMocks.set.mockResolvedValue(undefined);

    await resolveChatMcpElicitation({
      id: "00000000-0000-4000-8000-000000000002",
      response: {
        conversationId: "00000000-0000-4000-8000-000000000001",
        action: "decline",
      },
    });

    expect(cacheManagerMocks.set).toHaveBeenCalledWith(
      "chat-mcp-elicitation-00000000-0000-4000-8000-000000000002",
      {
        conversationId: "00000000-0000-4000-8000-000000000001",
        action: "decline",
      },
      10 * 60 * 1000,
    );
  });
});
