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

  test("backs off polling while waiting for a user response", async () => {
    vi.useFakeTimers();
    const writer = { write: vi.fn() };
    const bridge = createChatMcpElicitationBridge({
      conversationId: "00000000-0000-4000-8000-000000000001",
    });
    bridge.setWriter(writer);

    cacheManagerMocks.getAndDelete
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        conversationId: "00000000-0000-4000-8000-000000000001",
        action: "accept",
        content: { project: "alpha" },
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

    expect(cacheManagerMocks.getAndDelete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(cacheManagerMocks.getAndDelete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cacheManagerMocks.getAndDelete).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(499);
    expect(cacheManagerMocks.getAndDelete).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(cacheManagerMocks.getAndDelete).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(999);
    expect(cacheManagerMocks.getAndDelete).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({
      action: "accept",
      content: { project: "alpha" },
    });
  });

  test("stops waiting immediately when the chat stream aborts during polling sleep", async () => {
    vi.useFakeTimers();
    const writer = { write: vi.fn() };
    const abortController = new AbortController();
    const bridge = createChatMcpElicitationBridge({
      conversationId: "00000000-0000-4000-8000-000000000001",
      abortSignal: abortController.signal,
    });
    bridge.setWriter(writer);

    cacheManagerMocks.getAndDelete.mockResolvedValue(undefined);

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

    await vi.waitFor(() =>
      expect(cacheManagerMocks.getAndDelete).toHaveBeenCalled(),
    );

    abortController.abort();

    await expect(resultPromise).rejects.toThrow(
      "MCP elicitation cancelled because chat stream stopped",
    );
  });

  test("elicit() streams a form request and returns the answered outcome", async () => {
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
        content: { features: ["search"] },
      });

    const outcomePromise = bridge.elicit({
      toolName: "archestra__refine_app",
      message: "What should the app do?",
      requestedSchema: {
        type: "object",
        properties: { features: { type: "array" } },
      },
    });

    expect(writer.write).toHaveBeenCalledWith({
      type: "data-mcp-elicitation",
      data: expect.objectContaining({
        conversationId: "00000000-0000-4000-8000-000000000001",
        toolName: "archestra__refine_app",
        message: "What should the app do?",
        mode: "form",
        requestedSchema: expect.objectContaining({ type: "object" }),
      }),
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(outcomePromise).resolves.toEqual({
      status: "answered",
      result: { action: "accept", content: { features: ["search"] } },
    });
  });

  test("elicit() returns no_viewer when no chat stream writer is attached", async () => {
    const bridge = createChatMcpElicitationBridge({
      conversationId: "00000000-0000-4000-8000-000000000001",
    });

    await expect(
      bridge.elicit({ toolName: "archestra__refine_app", message: "Hi?" }),
    ).resolves.toEqual({ status: "no_viewer" });
    expect(cacheManagerMocks.getAndDelete).not.toHaveBeenCalled();
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
