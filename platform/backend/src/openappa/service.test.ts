import { vi } from "vitest";
import {
  executeArchestraTool,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import config from "@/config";
import * as database from "@/database";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { checkToolCalls, processProxyResults } from "./service";

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

beforeEach(async () => {
  config.llmProxy.plugins = ["appa"];
  config.openappa = { enabled: true, yellEnabled: false };
  await GuardrailsDeploymentModel.setEnabled(true);
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
  test("reporting is hidden and direct execution is refused until explicitly enabled", async () => {
    expect(
      getArchestraMcpTools().some((tool) => tool.name === "archestra__yell"),
    ).toBe(false);
    await expect(
      executeArchestraTool(
        "archestra__yell",
        { message: "Confusing feedback", with_trajectory: true },
        {
          agent: { id: "agent", name: "Assistant" },
          organizationId: "org",
          userId: "alice",
          sessionId: "conversation",
          currentToolCallId: "report",
        },
      ),
    ).rejects.toMatchObject({ code: -32601 });
    expect(native.dispatchHook).not.toHaveBeenCalled();
    config.openappa.yellEnabled = true;
    expect(
      getArchestraMcpTools().some((tool) => tool.name === "archestra__yell"),
    ).toBe(true);
  });

  test("reports through the authenticated native session after policy checking", async () => {
    config.openappa.yellEnabled = true;
    const args = { message: "Confusing feedback", with_trajectory: true };
    native.dispatchHook
      .mockResolvedValueOnce(JSON.stringify({ decision: "allow_call" }))
      .mockResolvedValueOnce(
        JSON.stringify({
          decision: "mcp_result",
          result: { content: [{ type: "text", text: "Receipt report-1" }] },
        }),
      );
    expect(
      await checkToolCalls(
        session,
        [{ id: "report", name: "archestra__yell", arguments: args }],
        (name) => name,
      ),
    ).toBeNull();
    const result = await executeArchestraTool("archestra__yell", args, {
      agent: { id: "agent", name: "Assistant" },
      agentId: "agent",
      organizationId: "org",
      userId: "alice",
      sessionId: "conversation",
      currentToolCallId: "report",
    });
    expect(result.content).toEqual([
      { type: "text", text: "Receipt report-1" },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw)),
    ).toEqual([
      {
        ...session,
        event: "tool_call",
        operation_id: "call:report",
        tool: "yell",
        arguments: args,
        spawn: false,
      },
      {
        ...session,
        event: "yell",
        operation_id: "yell:report",
        arguments: args,
      },
    ]);
  });

  test("reporting refuses missing identity and unprotected child calls", async () => {
    config.openappa.yellEnabled = true;
    const args = { message: "Confusing feedback", with_trajectory: false };
    await expect(
      executeArchestraTool("archestra__yell", args, {
        agent: { id: "agent", name: "Assistant" },
        organizationId: "org",
        userId: "alice",
      }),
    ).rejects.toThrow("requires an authenticated session");
    const parent = "a637fb55-989b-4f01-a251-e7e277c65f05";
    const child = "3c0f2458-f26a-4b05-9571-a64dca1d65a7";
    await expect(
      executeArchestraTool("archestra__yell", args, {
        agent: { id: child, name: "Child" },
        delegationChain: `${parent}:${child}`,
        organizationId: "org",
        sessionId: "conversation",
        currentToolCallId: "report",
      }),
    ).rejects.toMatchObject({ code: -32601 });
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("admits multiple calls before any result arrives", async () => {
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "allow_call" }),
    );
    const calls = [
      { id: "first", name: "read_file", arguments: {} },
      { id: "second", name: "read_file", arguments: {} },
    ];
    expect(await checkToolCalls(session, calls, (name) => name)).toBeNull();
    expect(
      native.dispatchHook.mock.calls.map(
        ([raw]) => JSON.parse(raw).operation_id,
      ),
    ).toEqual(["call:first", "call:second"]);
  });

  test.each([
    false,
    true,
  ])("settles only admissions from a withheld batch (throws=%s)", async (throws) => {
    const open = new Set<string>(["unrelated"]);
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event === "cancel_call") {
        open.delete(event.tool_call_id);
        return JSON.stringify({ decision: "deny_call" });
      }
      if (event.tool === "blocked") {
        if (throws) throw new Error("native failure");
        return JSON.stringify({
          decision: "deny_call",
          feedback: "Policy denied",
        });
      }
      open.add(event.operation_id.slice("call:".length));
      return JSON.stringify({ decision: "allow_call" });
    });
    const check = checkToolCalls(
      session,
      [
        { id: "first", name: "read_file", arguments: {} },
        { id: "second", name: "blocked", arguments: {} },
        { id: "third", name: "read_file", arguments: {} },
      ],
      (name) => name,
    );
    if (throws) {
      await expect(check).rejects.toThrow("OpenAPPA could not safely complete");
    } else {
      expect((await check)?.reason).toBe("Policy denied");
    }
    expect([...open]).toEqual(["unrelated"]);
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw).event),
    ).toEqual(["tool_call", "tool_call", "cancel_call"]);
    expect(
      await checkToolCalls(
        session,
        [{ id: "retry", name: "read_file", arguments: {} }],
        (name) => name,
      ),
    ).toBeNull();
  });

  test("refuses malformed arguments and duplicate IDs before admitting any call", async () => {
    const first = { id: "first", name: "read_file", arguments: {} };
    for (const second of [
      { id: "second", name: "read_file", arguments: "{" },
      first,
    ]) {
      await expect(
        checkToolCalls(session, [first, second], (name) => name),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("fails closed when a withheld admission cannot be settled", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event === "cancel_call") throw new Error("storage unavailable");
      return JSON.stringify(
        event.tool === "blocked"
          ? { decision: "deny_call", feedback: "Policy denied" }
          : { decision: "allow_call" },
      );
    });
    await expect(
      checkToolCalls(
        session,
        [
          { id: "first", name: "read_file", arguments: {} },
          { id: "second", name: "blocked", arguments: {} },
        ],
        (name) => name,
      ),
    ).rejects.toThrow("OpenAPPA could not safely complete");
  });

  test.each([
    "agent__research",
    "skill__research",
  ])("checks %s as an ordinary tool, including run_tool dispatch", async (toolName) => {
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "allow_call" }),
    );
    for (const wrapped of [false, true]) {
      const call = {
        id: `delegation-${wrapped}`,
        name: wrapped ? "archestra__run_tool" : toolName,
        arguments: wrapped
          ? { tool_name: toolName, tool_args: { message: "Research" } }
          : { message: "Research" },
      };
      expect(await checkToolCalls(session, [call], (name) => name)).toBeNull();
      expect(
        JSON.parse(
          native.dispatchHook.mock.calls[
            native.dispatchHook.mock.calls.length - 1
          ][0],
        ),
      ).toMatchObject({
        event: "tool_call",
        tool: toolName,
        arguments: { message: "Research" },
        spawn: false,
      });
    }
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({
        decision: "deny_call",
        feedback: "Parent policy denied",
      }),
    );
    const denied = await checkToolCalls(
      session,
      [{ id: "denied", name: toolName, arguments: { message: "Research" } }],
      (name) => name,
    );
    expect(denied?.reason).toBe("Parent policy denied");
  });

  test("does not let an unprotected child execute a remedy on the parent session", async () => {
    const parent = "a637fb55-989b-4f01-a251-e7e277c65f05";
    const child = "3c0f2458-f26a-4b05-9571-a64dca1d65a7";
    await expect(
      executeArchestraTool(
        "archestra__execute_remedy_plan",
        { offer_id: "parent-offer" },
        {
          agent: { id: child, name: "Child" },
          agentId: child,
          delegationChain: `${parent}:${child}`,
          organizationId: "org",
          sessionId: "conversation",
          currentToolCallId: "child-remedy",
        },
      ),
    ).rejects.toMatchObject({ code: -32601 });
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("does not initialize or dispatch while disabled, even with an explicit plugin entry", async () => {
    config.openappa.enabled = false;
    // An explicit plugin entry must not override the feature flag.
    config.llmProxy.plugins = ["appa"];
    await expect(processProxyResults(session, [])).rejects.toThrow(
      "OpenAPPA could not safely complete",
    );
    expect(native.initializeOpenappa).not.toHaveBeenCalled();
    expect(native.dispatchHook).not.toHaveBeenCalled();
    expect(database.getDatabaseConnectionString).not.toHaveBeenCalled();
  });
  test("hides the remedy tool and rejects direct calls without an agent while disabled", async () => {
    config.openappa.enabled = false;
    // An explicit plugin entry must not override the feature flag.
    config.llmProxy.plugins = ["appa"];
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
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({
        decision: "mcp_result",
        result: { content: [{ type: "text", text: "APPA remedy completed" }] },
      }),
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
    ).toEqual(["remedy"]);
  });

  test.each([
    true,
    false,
  ])("preserves APPA remedy feedback and error status without opening Chat prompts (isError=%s)", async (isError) => {
    const appaResult = {
      isError,
      content: [{ type: "text", text: "APPA: authority unreachable" }],
    };
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "mcp_result", result: appaResult }),
    );
    const elicit = vi.fn();
    const result = await executeArchestraTool(
      "archestra__execute_remedy_plan",
      { offer_id: "human-offer" },
      {
        agent: { id: "agent", name: "Assistant" },
        agentId: "agent",
        organizationId: "org",
        userId: "alice",
        sessionId: "conversation",
        currentToolCallId: "human-remedy",
        elicitation: { elicit, setWriter: vi.fn(), createHandler: vi.fn() },
      },
    );
    expect(result).toMatchObject(appaResult);
    expect(elicit).not.toHaveBeenCalled();
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw)),
    ).toEqual([
      {
        ...session,
        event: "remedy",
        operation_id: "remedy:human-remedy",
        arguments: { offer_id: "human-offer" },
      },
    ]);
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

test("dispatch loads the latest saved policy text from the organization database", async ({
  makeOrganization,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const content = "[policy]\nversion = 2\n";
  const scoped = { ...session, organization_id: organization.id };
  await GuardrailsPolicyModel.save({
    organizationId: organization.id,
    updatedBy: user.id,
    content,
    contentHash: "first",
    expectedRevision: 0,
  });
  await processProxyResults(scoped, []);
  expect(native.dispatchHook).toHaveBeenLastCalledWith(
    expect.any(String),
    content,
  );
  const updated = `${content}# updated`;
  await GuardrailsPolicyModel.save({
    organizationId: organization.id,
    updatedBy: user.id,
    content: updated,
    contentHash: "second",
    expectedRevision: 1,
  });
  await processProxyResults(scoped, []);
  expect(native.dispatchHook).toHaveBeenLastCalledWith(
    expect.any(String),
    updated,
  );
});
