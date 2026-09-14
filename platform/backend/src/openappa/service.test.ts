import { vi } from "vitest";
import {
  executeArchestraTool,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import config from "@/config";
import * as database from "@/database";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { processProxyResults } from "./service";

const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(),
  dispatchHook: vi.fn(),
}));
vi.mock("@archestra/openappa-rs", () => native);
const session = {
  organization_id: "org",
  caller_id: "user:alice",
  session_id: "conversation",
};

beforeEach(() => {
  config.openappa = { enabled: true, policyPath: "/test/policy.toml" };
  vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
    "postgresql://test:test@localhost/test",
  );
  native.dispatchHook.mockImplementation(async (raw: string) => {
    const event = JSON.parse(raw);
    return JSON.stringify(
      event.event === "tool_result"
        ? {
            decision: "replace_output",
            approved_output: "APPA: withheld; remedy offer-123",
          }
        : { decision: "ack" },
    );
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("APPA feature boundary", () => {
  test("does not initialize or dispatch while disabled, even with a configured path", async () => {
    config.openappa.enabled = false;
    await expect(processProxyResults(session, [])).rejects.toThrow(
      "OpenAPPA could not safely complete",
    );
    expect(native.initializeOpenappa).not.toHaveBeenCalled();
    expect(native.dispatchHook).not.toHaveBeenCalled();
    expect(database.getDatabaseConnectionString).not.toHaveBeenCalled();
  });
  test("hides the remedy tool and rejects direct calls without an agent while disabled", async () => {
    config.openappa.enabled = false;
    expect(
      getArchestraMcpTools().some((tool) =>
        tool.name.endsWith("__execute_remedy_plan"),
      ),
    ).toBe(false);
    await expect(
      executeArchestraTool(
        "archestra__execute_remedy_plan",
        { offer_id: "offer" },
        {
          agent: { id: "agent", name: "Assistant" },
          organizationId: "org",
          userId: "alice",
          sessionId: "conversation",
        },
      ),
    ).rejects.toMatchObject({ code: -32601 });
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });
  test("exposes the remedy tool only when enabled", () => {
    expect(
      getArchestraMcpTools().some((tool) =>
        tool.name.endsWith("__execute_remedy_plan"),
      ),
    ).toBe(true);
  });
  test("executes the enabled special MCP remedy through the native binding", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) =>
      JSON.stringify(
        JSON.parse(raw).event === "remedy_review"
          ? { decision: "review", review: [] }
          : {
              decision: "mcp_result",
              result: {
                content: [{ type: "text", text: "APPA remedy completed" }],
              },
            },
      ),
    );
    const result = await executeArchestraTool(
      "archestra__execute_remedy_plan",
      { offer_id: "offer" },
      {
        agent: { id: "agent", name: "Assistant" },
        agentId: "agent",
        organizationId: "org",
        userId: "alice",
        sessionId: "conversation",
        currentToolCallId: "remedy-call",
      },
    );
    expect(result.content).toEqual([
      { type: "text", text: "APPA remedy completed" },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw).event),
    ).toEqual(["remedy_review", "remedy"]);
  });

  test("admits the first client result without Chat execution reporting", async () => {
    const result = await processProxyResults(session, [
      {
        id: "call",
        name: "read_file",
        content: "RAW RESULT",
        isError: false,
      },
    ]);
    expect(result.toolResultUpdates).toEqual({
      call: "APPA: withheld; remedy offer-123",
    });
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw)),
    ).toEqual([
      { ...session, event: "session_start" },
      {
        ...session,
        event: "tool_result",
        tool_call_id: "call",
        output: "RAW RESULT",
        outcome: "success",
      },
    ]);
  });
  test("keeps a structured cancellation indeterminate when processing proxy results", async () => {
    await processProxyResults(session, [
      {
        id: "cancelled",
        name: "read_file",
        content: "Partial output",
        isError: true,
        _meta: {
          archestraError: { type: "cancelled", message: "Stopped by user" },
        },
      },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw)),
    ).toContainEqual(
      expect.objectContaining({
        event: "tool_result",
        tool_call_id: "cancelled",
        outcome: "unknown",
      }),
    );
  });
});
