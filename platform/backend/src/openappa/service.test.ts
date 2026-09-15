import { vi } from "vitest";
import {
  executeArchestraTool,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import config from "@/config";
import * as database from "@/database";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  APPA_PARENT_HEADER,
  APPA_SESSION_HEADER,
  executeRemedy,
  sessionFromHeaders,
} from "./service";

const native = vi.hoisted(() => ({
  dispatchHook: vi.fn(),
  initializeOpenappa: vi.fn(),
}));

vi.mock("@archestra/openappa-rs", () => native);

const session = {
  organization_id: "organization",
  caller_id: "user:caller",
  session_id: "session",
};

describe("OpenAPPA native service", () => {
  beforeEach(() => {
    config.llmProxy.plugins = ["appa"];
    config.openappa = { enabled: true, policyPath: "/policy.toml" };
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      "postgresql://user:secret@localhost/openappa?schema=public",
    );
    native.initializeOpenappa.mockResolvedValue(undefined);
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({
        decision: "mcp_result",
        result: { content: [{ type: "text", text: "remedy applied" }] },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  test("keeps the remedy tool unavailable while the feature is disabled", async () => {
    config.llmProxy.plugins = [];
    expect(
      getArchestraMcpTools().some((tool) =>
        tool.name.endsWith("__execute_remedy_plan"),
      ),
    ).toBe(false);

    await expect(
      executeArchestraTool(
        "archestra__execute_remedy_plan",
        { offer_id: "offer-1" },
        {
          agent: { id: "agent", name: "Assistant" },
          organizationId: "organization",
          userId: "caller",
          sessionId: "session",
        },
      ),
    ).rejects.toMatchObject({ code: -32601 });
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("exposes and dispatches the remedy tool while enabled", async () => {
    expect(
      getArchestraMcpTools().some((tool) =>
        tool.name.endsWith("__execute_remedy_plan"),
      ),
    ).toBe(true);

    await expect(
      executeArchestraTool(
        "archestra__execute_remedy_plan",
        { offer_id: "offer-1" },
        {
          agent: { id: "agent", name: "Assistant" },
          organizationId: "organization",
          userId: "caller",
          sessionId: "session",
          currentToolCallId: "remedy-call",
        },
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "remedy applied" }],
    });
  });

  test("dispatches an exact remedy operation to the embedded binding", async () => {
    await expect(
      executeRemedy(session, "call-1", { offer_id: "offer-1" }),
    ).resolves.toEqual({
      content: [{ type: "text", text: "remedy applied" }],
    });

    expect(native.dispatchHook).toHaveBeenCalledWith(
      JSON.stringify({
        ...session,
        event: "remedy",
        operation_id: "remedy:call-1",
        arguments: { offer_id: "offer-1" },
      }),
    );
  });

  test("does not expose native connection diagnostics", async () => {
    native.dispatchHook.mockRejectedValue(
      new Error("postgresql://user:secret@localhost/openappa failed"),
    );

    await expect(
      executeRemedy(session, "call-1", { offer_id: "offer-1" }),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: "OpenAPPA could not safely complete this operation",
    });
  });

  test("accepts only authenticated, bounded proxy session headers", () => {
    expect(
      sessionFromHeaders({
        headers: {
          [APPA_SESSION_HEADER.toLowerCase()]: "child-session",
          [APPA_PARENT_HEADER.toLowerCase()]: "parent-session",
        },
        organizationId: "organization",
        callerId: "user:caller",
      }),
    ).toEqual({
      organization_id: "organization",
      caller_id: "user:caller",
      session_id: "child-session",
      parent_id: "parent-session",
    });

    expect(() =>
      sessionFromHeaders({
        headers: { [APPA_SESSION_HEADER.toLowerCase()]: "child-session" },
        organizationId: "organization",
      }),
    ).toThrow("requires an authenticated");
  });
});
