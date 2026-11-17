/**
 * Focused unit tests for the PreToolUse / PostToolUse lifecycle-hook helpers
 * inside chat-mcp-client. The helpers are unexported internals exposed via
 * the `__test` object.
 *
 * hookDispatcherService.fire is stubbed with vi.spyOn so the real sandbox
 * runtime is never touched.
 */
import { TOOL_RUN_TOOL_FULL_NAME } from "@archestra/shared";
import { afterEach, describe, expect, test, vi } from "vitest";
import { hookDispatcherService } from "@/hooks/hook-dispatcher-service";
import { __test as chatClient } from "./chat-tool-builder";

const {
  firePreToolUseHook,
  firePostToolUseHook,
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
  test("fires against the run scope in a headless run (no conversationId)", async () => {
    const spy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockResolvedValueOnce({ decision: "proceed" });

    const result = await firePreToolUseHook({
      ctx: { ...BASE_CTX, conversationId: undefined, scopeKey: "run-xyz" },
      toolName: "my_tool",
      toolInput: {},
    });

    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: undefined,
        isolationKey: "run-xyz",
      }),
    );
  });

  test("returns null (proceed) without firing when the run has no scope", async () => {
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
describe("run_tool dispatches", () => {
  const runToolCall = {
    toolName: TOOL_RUN_TOOL_FULL_NAME,
    toolInput: {
      tool_name: "github__delete_repo",
      tool_args: { repo: "acme/widgets" },
    },
  };
  const targetFields = {
    tool_name: "github__delete_repo",
    tool_input: { repo: "acme/widgets" },
  };

  test("PreToolUse sees the target tool and its arguments", async () => {
    const spy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockResolvedValueOnce({ decision: "proceed" });

    await firePreToolUseHook({ ctx: BASE_CTX, ...runToolCall });

    expect(spy.mock.calls[0][0].fields).toEqual(targetFields);
  });

  test("PostToolUse sees the target tool and its arguments", async () => {
    const spy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockResolvedValueOnce({ decision: "proceed" });

    await firePostToolUseHook({
      ctx: BASE_CTX,
      ...runToolCall,
      toolResponse: "deleted",
    });

    expect(spy.mock.calls[0][0].fields).toEqual({
      ...targetFields,
      tool_response: "deleted",
    });
  });

  test("a run_tool call without a target name stays the wrapper", async () => {
    const spy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockResolvedValueOnce({ decision: "proceed" });

    await firePreToolUseHook({
      ctx: BASE_CTX,
      toolName: TOOL_RUN_TOOL_FULL_NAME,
      toolInput: { tool_args: {} },
    });

    expect(spy.mock.calls[0][0].fields).toEqual({
      tool_name: TOOL_RUN_TOOL_FULL_NAME,
      tool_input: { tool_args: {} },
    });
  });
});

describe("firePostToolUseHook", () => {
  test("fires against the run scope in a headless run (no conversationId)", async () => {
    const spy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockResolvedValueOnce({ decision: "proceed" });

    const result = await firePostToolUseHook({
      ctx: { ...BASE_CTX, conversationId: undefined, scopeKey: "run-xyz" },
      toolName: "my_tool",
      toolInput: {},
      toolResponse: "ok",
    });

    expect(result).toBeNull();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: undefined,
        isolationKey: "run-xyz",
      }),
    );
  });

  test("returns null (proceed) without firing when the run has no scope", async () => {
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
