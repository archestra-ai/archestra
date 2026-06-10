/**
 * Focused unit tests for the PreToolUse / PostToolUse lifecycle-hook helpers
 * inside chat-mcp-client. The helpers are unexported internals exposed via
 * the `__test` object.
 *
 * hookDispatcherService.fire is stubbed with vi.spyOn so the real sandbox
 * runtime is never touched.
 */
import { vi } from "vitest";
import { hookDispatcherService } from "@/hooks/hook-dispatcher-service";
import { afterEach, describe, expect, test } from "@/test";
import { __test as chatClient } from "./chat-mcp-client";

const {
  firePreToolUseHook,
  firePostToolUseHook,
  appendHookFeedbackToToolResult,
  buildPreToolUseBlockedResult,
  toolResultText,
} = chatClient;

const BASE_CTX = {
  agentId: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  conversationId: "conv-abc",
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// toolResultText
// ---------------------------------------------------------------------------
describe("toolResultText", () => {
  test("passes a plain string through unchanged", () => {
    expect(toolResultText("hello world")).toBe("hello world");
  });

  test("extracts content from a rich object result", () => {
    expect(toolResultText({ content: "tool output", _meta: { ui: {} } })).toBe(
      "tool output",
    );
  });
});

// ---------------------------------------------------------------------------
// appendHookFeedbackToToolResult
// ---------------------------------------------------------------------------
describe("appendHookFeedbackToToolResult", () => {
  test("appends feedback to a plain string result", () => {
    const result = appendHookFeedbackToToolResult(
      "original output",
      "you shall not pass",
    );
    expect(result).toBe(
      "original output\n\n[hook feedback] you shall not pass",
    );
  });

  test("appends feedback to the content field of a rich object result", () => {
    const rich = {
      content: "original output",
      _meta: { ui: { resourceUri: "res://ui" } },
    };
    const result = appendHookFeedbackToToolResult(rich, "blocked by policy");

    expect(result.content).toBe(
      "original output\n\n[hook feedback] blocked by policy",
    );
  });

  test("preserves all extra keys on a rich object result (spread intact)", () => {
    const rich = {
      content: "data",
      _meta: { ui: { resourceUri: "res://ui" }, extra: 42 },
      structuredContent: { rows: [1, 2, 3] },
      rawContent: [{ type: "text" as const, text: "data" }],
    };
    const result = appendHookFeedbackToToolResult(rich, "feedback");

    // shape is preserved
    expect(result._meta).toEqual({
      ui: { resourceUri: "res://ui" },
      extra: 42,
    });
    expect(result.structuredContent).toEqual({ rows: [1, 2, 3] });
    expect(result.rawContent).toEqual([{ type: "text", text: "data" }]);
    // only content changed
    expect(result.content).toContain("[hook feedback] feedback");
  });
});

// ---------------------------------------------------------------------------
// buildPreToolUseBlockedResult
// ---------------------------------------------------------------------------
describe("buildPreToolUseBlockedResult", () => {
  test("includes the reason in the returned string", () => {
    const result = buildPreToolUseBlockedResult("dangerous call");
    expect(result).toContain("blocked");
    expect(result).toContain("dangerous call");
  });

  test("uses a fallback message when reason is null", () => {
    const result = buildPreToolUseBlockedResult(null);
    expect(result).toContain("no reason given");
  });
});

// ---------------------------------------------------------------------------
// firePreToolUseHook
// ---------------------------------------------------------------------------
describe("firePreToolUseHook", () => {
  test("returns null (proceed) when conversationId is absent", async () => {
    const spy = vi.spyOn(hookDispatcherService, "fire");

    const result = await firePreToolUseHook({
      ctx: { ...BASE_CTX, conversationId: undefined },
      toolName: "my_tool",
      toolInput: {},
    });

    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test("returns null (proceed) when dispatcher returns proceed", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockResolvedValueOnce({
      decision: "proceed",
    });

    const result = await firePreToolUseHook({
      ctx: BASE_CTX,
      toolName: "my_tool",
      toolInput: { key: "value" },
    });

    expect(result).toBeNull();
  });

  test("returns the block reason when dispatcher returns block", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockResolvedValueOnce({
      decision: "block",
      reason: "tool is not permitted",
    });

    const result = await firePreToolUseHook({
      ctx: BASE_CTX,
      toolName: "my_tool",
      toolInput: {},
    });

    expect(result).toBe("tool is not permitted");
  });

  test("returns null when block decision has no reason (null fallback)", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockResolvedValueOnce({
      decision: "block",
      // reason omitted
    });

    const result = await firePreToolUseHook({
      ctx: BASE_CTX,
      toolName: "my_tool",
      toolInput: {},
    });

    expect(result).toBeNull();
  });

  test("fails open (returns null) when dispatcher throws", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockRejectedValueOnce(
      new Error("sandbox unavailable"),
    );

    await expect(
      firePreToolUseHook({
        ctx: BASE_CTX,
        toolName: "my_tool",
        toolInput: {},
      }),
    ).resolves.toBeNull();
  });

  test("calls fire with the correct PreToolUse event and fields", async () => {
    const spy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockResolvedValueOnce({ decision: "proceed" });

    await firePreToolUseHook({
      ctx: BASE_CTX,
      toolName: "my_tool",
      toolInput: { arg: 1 },
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "pre_tool_use",
        conversationId: BASE_CTX.conversationId,
        agentId: BASE_CTX.agentId,
        fields: expect.objectContaining({
          tool_name: "my_tool",
          tool_input: { arg: 1 },
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// firePostToolUseHook
// ---------------------------------------------------------------------------
describe("firePostToolUseHook", () => {
  test("returns null (proceed) when conversationId is absent", async () => {
    const spy = vi.spyOn(hookDispatcherService, "fire");

    const result = await firePostToolUseHook({
      ctx: { ...BASE_CTX, conversationId: undefined },
      toolName: "my_tool",
      toolInput: {},
      toolResponse: "ok",
    });

    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test("returns null when dispatcher returns proceed", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockResolvedValueOnce({
      decision: "proceed",
      injectedContext: "some context",
    });

    const result = await firePostToolUseHook({
      ctx: BASE_CTX,
      toolName: "my_tool",
      toolInput: {},
      toolResponse: "result text",
    });

    // injectedContext on proceed is intentionally ignored in Phase 1
    expect(result).toBeNull();
  });

  test("returns null when dispatcher returns block without a reason", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockResolvedValueOnce({
      decision: "block",
      // no reason
    });

    const result = await firePostToolUseHook({
      ctx: BASE_CTX,
      toolName: "my_tool",
      toolInput: {},
      toolResponse: "result text",
    });

    expect(result).toBeNull();
  });

  test("returns the reason when dispatcher blocks with a reason", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockResolvedValueOnce({
      decision: "block",
      reason: "response contained PII",
    });

    const result = await firePostToolUseHook({
      ctx: BASE_CTX,
      toolName: "my_tool",
      toolInput: {},
      toolResponse: "some sensitive output",
    });

    expect(result).toBe("response contained PII");
  });

  test("fails open (returns null) when dispatcher throws", async () => {
    vi.spyOn(hookDispatcherService, "fire").mockRejectedValueOnce(
      new Error("sandbox timeout"),
    );

    await expect(
      firePostToolUseHook({
        ctx: BASE_CTX,
        toolName: "my_tool",
        toolInput: {},
        toolResponse: "result",
      }),
    ).resolves.toBeNull();
  });

  test("calls fire with the correct PostToolUse event and fields", async () => {
    const spy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockResolvedValueOnce({ decision: "proceed" });

    await firePostToolUseHook({
      ctx: BASE_CTX,
      toolName: "my_tool",
      toolInput: { q: "test" },
      toolResponse: "response text",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "post_tool_use",
        conversationId: BASE_CTX.conversationId,
        agentId: BASE_CTX.agentId,
        fields: expect.objectContaining({
          tool_name: "my_tool",
          tool_input: { q: "test" },
          tool_response: "response text",
        }),
      }),
    );
  });
});
