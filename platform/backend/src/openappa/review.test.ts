import { vi } from "vitest";
import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import * as database from "@/database";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { getChatReview, registerChatReview } from "./chat-review";
import { checkToolCalls, executeRemedy } from "./service";

const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(),
  dispatchHook: vi.fn(),
}));
vi.mock("@archestra/openappa-rs", () => native);
const session = {
  organization_id: "org",
  caller_id: "user:alice",
  session_id: "chat",
};
const review = {
  offer_id: "offer",
  text: "Native review: send to partner@example.com, subject Demo, body Fictional.",
};
beforeEach(() => {
  vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
    "postgresql://test:test@localhost/test",
  );
  vi.stubEnv("ARCHESTRA_OPENAPPA_POLICY_PATH", "/test/policy.toml");
  native.dispatchHook.mockImplementation(async (input: string) =>
    JSON.stringify(
      JSON.parse(input).event === "remedy_review"
        ? { decision: "review", review: [review] }
        : {
            decision: "mcp_result",
            result: { content: [{ type: "text", text: "Recorded" }] },
          },
    ),
  );
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("embedded host review", () => {
  test("the first blocked call opens the form and resumes the exact call after approval", async () => {
    const events: Record<string, unknown>[] = [];
    native.dispatchHook.mockImplementation(async (input: string) => {
      const event = JSON.parse(input);
      events.push(event);
      return JSON.stringify(
        event.event === "tool_call"
          ? {
              decision: "deny_call",
              review: [review],
              feedback:
                "Why:\n  - trust is suspicious, below the required floor trusted",
            }
          : event.event === "remedy_review"
            ? { decision: "review", review: [review] }
            : event.event === "remedy"
              ? { decision: "mcp_result", result: { content: [] } }
              : { decision: "allow_call", reviewed: true },
      );
    });
    const elicit = vi.fn().mockResolvedValue({
      status: "answered",
      result: { action: "accept" },
    });
    const args = { to: "partner@example.com", subject: "Budget", body: "Plan" };
    expect(
      await checkToolCalls(
        session,
        [{ id: "email", name: "send_email", arguments: args }],
        (name) => name,
        { elicit } as unknown as ChatMcpElicitationBridge,
      ),
    ).toBeNull();
    expect(elicit).toHaveBeenCalledOnce();
    expect(elicit).toHaveBeenCalledWith(
      expect.objectContaining({
        approval: expect.objectContaining({
          currentTrust: "suspicious",
          requiredTrust: "trusted",
          input: args,
        }),
      }),
    );
    expect(events.map((event) => event.event)).toEqual([
      "tool_call",
      "remedy_review",
      "remedy",
      "resume_tool_call",
    ]);
    expect(events[2]).toMatchObject({ ruling: "approve" });
    expect(events[3]).toMatchObject({
      operation_id: "call:email",
      tool: "send_email",
      arguments: args,
    });
  });

  test.each([
    "decline",
    "cancel",
  ] as const)("%s returns a deterministic refusal without resuming the original call", async (action) => {
    native.dispatchHook.mockImplementation(async (input: string) => {
      const event = JSON.parse(input);
      return JSON.stringify(
        event.event === "tool_call"
          ? { decision: "deny_call", review: [review] }
          : event.event === "remedy_review"
            ? { decision: "review", review: [review] }
            : { decision: "mcp_result", result: { content: [] } },
      );
    });
    const elicit = vi
      .fn()
      .mockResolvedValue({ status: "answered", result: { action } });
    const refused = await checkToolCalls(
      session,
      [
        {
          id: "email",
          name: "send_email",
          arguments: { to: "partner@example.com" },
        },
      ],
      (name) => name,
      { elicit } as unknown as ChatMcpElicitationBridge,
    );
    expect(refused?.contentMessage).toBe(
      action === "cancel"
        ? "Approval cancelled. The action was not performed."
        : "Approval declined. The action was not performed.",
    );
    const events = native.dispatchHook.mock.calls.map(([raw]) =>
      JSON.parse(raw),
    );
    expect(events.some((event) => event.event === "resume_tool_call")).toBe(
      false,
    );
    expect(events.filter((event) => event.event === "remedy")).toEqual(
      action === "cancel" ? [] : [expect.objectContaining({ ruling: "deny" })],
    );
  });

  test("audience denial cannot be turned into human approval", async () => {
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({
        decision: "deny_call",
        feedback: "Audience mismatch",
        review: [],
      }),
    );
    const elicit = vi.fn();
    const result = await checkToolCalls(
      session,
      [{ id: "email", name: "send_email", arguments: {} }],
      (name) => name,
      { elicit } as unknown as ChatMcpElicitationBridge,
    );
    expect(result?.contentMessage).toBe("Audience mismatch");
    expect(elicit).not.toHaveBeenCalled();
  });

  test("a narrowing offer reaches the model without automatic acceptance", async () => {
    native.dispatchHook.mockImplementation(async (input: string) => {
      const event = JSON.parse(input);
      return JSON.stringify(
        event.event === "tool_call"
          ? {
              decision: "deny_call",
              offers: [{ offer_id: "narrow" }],
              review: [],
            }
          : event.event === "remedy_review"
            ? { decision: "review", review: [] }
            : event.event === "remedy"
              ? { decision: "mcp_result", result: { content: [] } }
              : { decision: "allow_call", reviewed: true },
      );
    });
    const elicit = vi.fn();
    expect(
      await checkToolCalls(
        session,
        [{ id: "read", name: "read_file", arguments: {} }],
        (name) => name,
        { elicit } as unknown as ChatMcpElicitationBridge,
      ),
    ).not.toBeNull();
    expect(elicit).not.toHaveBeenCalled();
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw).event),
    ).toEqual(["tool_call"]);
  });

  test("the review channel is scoped to the caller and disappears on cleanup", () => {
    const bridge = { elicit: vi.fn() } as unknown as ChatMcpElicitationBridge;
    const remove = registerChatReview("turn", session, bridge);
    expect(getChatReview("turn", session)).toBe(bridge);
    for (const changed of [
      { caller_id: "user:bob" },
      { organization_id: "other" },
      { session_id: "other" },
      { parent_id: "other" },
    ])
      expect(getChatReview("turn", { ...session, ...changed })).toBeUndefined();
    remove();
    expect(getChatReview("turn", session)).toBeUndefined();
  });

  test("shows native review and takes the ruling only from the host dialog", async () => {
    const elicit = vi
      .fn()
      .mockResolvedValue({ status: "answered", result: { action: "decline" } });
    await executeRemedy(
      session,
      "call",
      { offer_id: "offer", ruling: "approve", explanation: "Do not show this" },
      { elicit } as unknown as ChatMcpElicitationBridge,
    );
    expect(elicit).toHaveBeenCalledWith(
      expect.objectContaining({ message: review.text }),
    );
    const execution = JSON.parse(native.dispatchHook.mock.calls[1][0]);
    expect(execution.ruling).toBe("deny");
    expect(execution.organization_id).toBe("org");
  });
  test("headless and cancelled reviews never execute a remedy", async () => {
    expect(
      (await executeRemedy(session, "call", { offer_id: "offer" })).isError,
    ).toBe(true);
    const elicit = vi
      .fn()
      .mockResolvedValue({ status: "answered", result: { action: "cancel" } });
    expect(
      (
        await executeRemedy(session, "call", { offer_id: "offer" }, {
          elicit,
        } as unknown as ChatMcpElicitationBridge)
      ).isError,
    ).toBe(true);
    expect(
      native.dispatchHook.mock.calls.every(
        ([input]) => JSON.parse(input).event === "remedy_review",
      ),
    ).toBe(true);
  });
  test("a completed durable remedy does not ask a second time", async () => {
    const result = { content: [{ type: "text", text: "Authorized" }] };
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "mcp_result", result }),
    );
    const elicit = vi.fn();
    expect(
      await executeRemedy(session, "call", { offer_id: "offer" }, {
        elicit,
      } as unknown as ChatMcpElicitationBridge),
    ).toEqual(result);
    expect(elicit).not.toHaveBeenCalled();
    expect(native.dispatchHook).toHaveBeenCalledTimes(1);
  });
  test("a completed refusal is returned without replaying the remedy", async () => {
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "refuse", detail: "Approval was declined" }),
    );
    const elicit = vi.fn();
    expect(
      await executeRemedy(session, "call", { offer_id: "offer" }, {
        elicit,
      } as unknown as ChatMcpElicitationBridge),
    ).toEqual({
      isError: true,
      content: [{ type: "text", text: "Approval was declined" }],
    });
    expect(elicit).not.toHaveBeenCalled();
    expect(native.dispatchHook).toHaveBeenCalledTimes(1);
  });
});
