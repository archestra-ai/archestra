import { SEEDED_APP_RENDER_META_KEY } from "@archestra/shared";
import { vi } from "vitest";
import {
  executeArchestraTool,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import config from "@/config";
import * as database from "@/database";
import logger from "@/logging";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  cancelCalls,
  evaluateToolCalls,
  executeRemedyByOffer,
  processProxyResults,
  sessionFromHeaders,
} from "./service";

const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(),
  dispatchHook: vi.fn(),
  executeRemedyByOffer: vi.fn(),
}));
vi.mock("@archestra/openappa-rs", () => native);
vi.mock("@/logging");
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
  native.executeRemedyByOffer.mockReset();
  native.executeRemedyByOffer.mockResolvedValue(
    JSON.stringify({
      decision: "mcp_result",
      offer: { status: "known" },
      result: { content: [{ type: "text", text: "[appa] Authorized." }] },
    }),
  );
  native.dispatchHook.mockImplementation(async (raw: string) => {
    const event = JSON.parse(raw);
    return JSON.stringify(
      event.event === "tool_result"
        ? {
            decision: "replace_output",
            approved_output: "APPA: withheld; remedy offer-123",
            output_source: "runtime",
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
      await evaluateToolCalls(
        session,
        [{ id: "report", name: "archestra__yell", arguments: args }],
        { canonicalize: (name) => name },
      ),
    ).toEqual([{ kind: "allow" }]);
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
        presentation: {
          control_tool: "archestra__execute_remedy_plan",
          supports_delegation: false,
        },
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

  test("proposes every call in provider order and answers each one on its own", async () => {
    // The runtime decides a batch, one call at a time: it releases the first and
    // refuses the second while that one is outstanding. Neither answer is the
    // proxy's, and the refusal reaches the model as this call's own ruling.
    native.dispatchHook
      .mockResolvedValueOnce(JSON.stringify({ decision: "allow_call" }))
      .mockResolvedValueOnce(
        JSON.stringify({
          decision: "deny_call",
          feedback: "[appa] a call is already outstanding",
        }),
      );
    const calls = [
      { id: "first", name: "read_file", arguments: {} },
      { id: "second", name: "read_file", arguments: {} },
    ];

    const decisions = await evaluateToolCalls(session, calls, {
      canonicalize: (name) => name,
    });

    expect(decisions).toEqual([
      { kind: "allow" },
      { kind: "deny", feedback: "[appa] a call is already outstanding" },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(
        ([raw]) => JSON.parse(raw).operation_id,
      ),
    ).toEqual(["call:first", "call:second"]);
  });

  test("admits multiple calls before any result arrives", async () => {
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "allow_call" }),
    );
    const calls = [
      { id: "first", name: "read_file", arguments: {} },
      { id: "second", name: "read_file", arguments: {} },
    ];
    expect(
      await evaluateToolCalls(session, calls, {
        canonicalize: (name) => name,
      }),
    ).toEqual([{ kind: "allow" }, { kind: "allow" }]);
    expect(
      native.dispatchHook.mock.calls.map(
        ([raw]) => JSON.parse(raw).operation_id,
      ),
    ).toEqual(["call:first", "call:second"]);
  });

  test.each([
    false,
    true,
  ])("settles admissions only when the batch is withheld (throws=%s)", async (throws) => {
    // A denial no longer withholds the batch: it is that call's own notice, and
    // the calls admitted beside it still run. Only a failure — which withholds
    // the whole response — settles what the runtime had already admitted.
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
    const options = {
      canonicalize: (name: string) => name,
    };
    const check = evaluateToolCalls(
      session,
      [
        { id: "first", name: "read_file", arguments: {} },
        { id: "second", name: "blocked", arguments: {} },
        { id: "third", name: "read_file", arguments: {} },
      ],
      options,
    );
    if (throws) {
      await expect(check).rejects.toThrow("OpenAPPA could not safely complete");
      expect([...open]).toEqual(["unrelated"]);
      expect(
        native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw).event),
      ).toEqual(["tool_call", "tool_call", "cancel_call"]);
    } else {
      expect(await check).toEqual([
        { kind: "allow" },
        { kind: "deny", feedback: "Policy denied" },
        { kind: "allow" },
      ]);
      expect([...open]).toEqual(["unrelated", "first", "third"]);
      expect(
        native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw).event),
      ).toEqual(["tool_call", "tool_call", "tool_call"]);
    }
    expect(
      await evaluateToolCalls(
        session,
        [{ id: "retry", name: "read_file", arguments: {} }],
        options,
      ),
    ).toEqual([{ kind: "allow" }]);
  });

  test("refuses malformed arguments and duplicate IDs before admitting any call", async () => {
    const first = { id: "first", name: "read_file", arguments: {} };
    for (const second of [
      { id: "second", name: "read_file", arguments: "{" },
      first,
    ]) {
      await expect(
        evaluateToolCalls(session, [first, second], {
          canonicalize: (name) => name,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("fails closed when a withheld admission cannot be settled", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event === "cancel_call") throw new Error("storage unavailable");
      if (event.tool === "blocked") throw new Error("native failure");
      return JSON.stringify({ decision: "allow_call" });
    });
    await expect(
      evaluateToolCalls(
        session,
        [
          { id: "first", name: "read_file", arguments: {} },
          { id: "second", name: "blocked", arguments: {} },
        ],
        { canonicalize: (name) => name },
      ),
    ).rejects.toThrow("OpenAPPA could not safely complete");
  });

  test("cancels admitted calls via Promise.allSettled and logs failure when cancellation rejects", async () => {
    vi.mocked(logger.warn).mockClear();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event === "cancel_call") {
        if (event.tool_call_id === "bad") throw new Error("database timeout");
        return JSON.stringify({ decision: "ack" });
      }
      return JSON.stringify({ decision: "allow_call" });
    });

    await cancelCalls(session, ["good", "bad"]);

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "bad",
        sessionId: "conversation",
      }),
      "Failed to cancel OpenAPPA admitted call",
    );
  });

  test("releases the model's own remedy call without proposing it again", async () => {
    // The gateway dispatches the one control ToolCall when the client runs it.
    // A second one here would vouch the offer twice for the same attempt.
    const decisions = await evaluateToolCalls(
      session,
      [
        {
          id: "remedy-call",
          name: "mcp__archestra__execute_remedy_plan",
          arguments: { offer_id: "offer-1" },
        },
      ],
      {
        canonicalize: (name) => name,
        controlToolName: "mcp__archestra__execute_remedy_plan",
      },
    );

    expect(decisions).toEqual([{ kind: "control" }]);
    expect(native.dispatchHook).not.toHaveBeenCalled();
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
      expect(
        await evaluateToolCalls(session, [call], {
          canonicalize: (name) => name,
        }),
      ).toEqual([{ kind: "allow" }]);
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
    // A denial is a notice addressed to the model, not a refusal of the whole
    // request, so the parent's verdict arrives as this call's feedback.
    const denied = await evaluateToolCalls(
      session,
      [{ id: "denied", name: toolName, arguments: { message: "Research" } }],
      { canonicalize: (name) => name },
    );
    expect(denied).toEqual([
      { kind: "deny", feedback: "Parent policy denied" },
    ]);
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
    await expect(processProxyResults({ session, results: [] })).rejects.toThrow(
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
  test("executes the enabled special MCP remedy through the native offer owner", async () => {
    native.executeRemedyByOffer.mockResolvedValue(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: {
          content: [{ type: "text", text: "APPA remedy completed" }],
        },
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
        currentToolCallId: "remedy-call-1",
      },
    );
    expect(result.content).toEqual([
      { type: "text", text: "APPA remedy completed" },
    ]);
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("the public notice tool preserves custom-call validation across encoded arguments", async () => {
    const context = {
      agent: { id: "agent", name: "Gateway" },
      organizationId: "org",
    };
    const notice = {
      tool: "exec",
      arguments: '{"input":"inspect"}',
      ruling: "Blocked by policy",
      notice: { v: 1, call_id: "custom-call", custom: true },
    };
    await expect(
      executeArchestraTool("archestra__get_remedy_plans", notice, context),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Blocked by policy" }],
    });
    await expect(
      executeArchestraTool(
        "archestra__get_remedy_plans",
        {
          ...notice,
          arguments: '{"input":"inspect","extra":true}',
        },
        context,
      ),
    ).resolves.toMatchObject({ isError: true });
    expect(native.dispatchHook).not.toHaveBeenCalled();
    expect(native.executeRemedyByOffer).not.toHaveBeenCalled();
  });

  test.each([
    true,
    false,
  ])("preserves APPA remedy feedback and error status without opening Chat prompts (isError=%s)", async (isError) => {
    const appaResult = {
      isError,
      content: [{ type: "text", text: "APPA: authority unreachable" }],
    };
    native.executeRemedyByOffer.mockResolvedValue(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: appaResult,
      }),
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
        currentToolCallId: "remedy-call-2",
        elicitation: { elicit, setWriter: vi.fn(), createHandler: vi.fn() },
      },
    );
    expect(result).toMatchObject(appaResult);
    expect(elicit).not.toHaveBeenCalled();
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("admits the first client result without Chat execution reporting", async () => {
    const result = await processProxyResults({
      session,
      controlToolName: "mcp__gateway__archestra__execute_remedy_plan",
      results: [
        {
          id: "call",
          name: "read_file",
          content: "RAW RESULT",
          isError: false,
        },
      ],
    });
    expect(result.toolResultUpdates).toEqual({
      call: {
        content: "APPA: withheld; remedy offer-123",
        outputSource: "runtime",
      },
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
        presentation: {
          control_tool: "mcp__gateway__archestra__execute_remedy_plan",
          supports_delegation: false,
        },
      },
    ]);
  });
  test("preserves an explicit native unknown-control ruling without inspecting its text", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      return JSON.stringify(
        event.event === "tool_result" && event.tool_call_id === "remedy"
          ? {
              decision: "replace_output",
              approved_output:
                "[appa] This remedy control call was not recognized. No plan was applied. Do not retry the remedy or re-propose the blocked call.",
              output_source: "runtime",
              reason: "unknown_control_call",
            }
          : event.event === "tool_result"
            ? {
                decision: "replace_output",
                approved_output:
                  "[appa] ordinary tool data must remain byte-for-byte",
              }
            : { decision: "ack" },
      );
    });
    const result = await processProxyResults({
      session,
      results: [
        {
          id: "remedy",
          name: "archestra__execute_remedy_plan",
          content: "Permission for this action was denied by the client.",
          isError: true,
        },
        {
          id: "call",
          name: "read_file",
          content: "RAW RESULT",
          isError: false,
        },
      ],
    });

    expect(result.toolResultUpdates.remedy).toEqual({
      content:
        "[appa] This remedy control call was not recognized. No plan was applied. Do not retry the remedy or re-propose the blocked call.",
      outputSource: "runtime",
      reason: "unknown_control_call",
    });
    expect(result.toolResultUpdates.call).toMatchObject({
      content: "[appa] ordinary tool data must remain byte-for-byte",
      outputSource: "tool",
    });
  });
  test("accepts mcp_result decision from native runtime for control tool results", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      return JSON.stringify(
        event.event === "tool_result" && event.tool_call_id === "remedy"
          ? {
              decision: "mcp_result",
              approved_output:
                "[appa] Authorized. Call the Write tool again with exactly these arguments: {}",
              output_source: "runtime",
            }
          : { decision: "ack" },
      );
    });
    const result = await processProxyResults({
      session,
      results: [
        {
          id: "remedy",
          name: "archestra__execute_remedy_plan",
          content: '{"result":"ok"}',
          isError: false,
        },
      ],
    });
    expect(result.toolResultUpdates).toEqual({
      remedy: {
        content:
          "[appa] Authorized. Call the Write tool again with exactly these arguments: {}",
        outputSource: "runtime",
      },
    });
  });
  test("handles unreleased tool denials returning deny_call with approved_output (chat bug reproduction)", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      return JSON.stringify(
        event.event === "tool_result" && event.tool_call_id === "denied_call"
          ? {
              decision: "deny_call",
              feedback:
                "tool archestra__download_file is not declared in this policy; the call is refused",
              approved_output:
                "[appa] Blocked: tool archestra__download_file is not declared in this policy.\n\nThe tool was not executed.",
              output_source: "runtime",
            }
          : { decision: "ack" },
      );
    });
    const result = await processProxyResults({
      session,
      results: [
        {
          id: "denied_call",
          name: "archestra__download_file",
          content: "original tool output",
          isError: false,
        },
      ],
    });
    expect(result.toolResultUpdates.denied_call).toEqual({
      content:
        "[appa] Blocked: tool archestra__download_file is not declared in this policy.\n\nThe tool was not executed.",
      outputSource: "runtime",
    });
  });
  test("handles block decision falling back to reason or feedback when approved_output is absent", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      return JSON.stringify(
        event.event === "tool_result" && event.tool_call_id === "blocked_call"
          ? {
              decision: "block",
              reason: "Output blocked due to policy violation",
            }
          : { decision: "ack" },
      );
    });
    const result = await processProxyResults({
      session,
      results: [
        {
          id: "blocked_call",
          name: "read_file",
          content: "sensitive file data",
          isError: false,
        },
      ],
    });
    expect(result.toolResultUpdates.blocked_call).toEqual({
      content: "Output blocked due to policy violation",
      outputSource: "runtime",
      reason: "Output blocked due to policy violation",
    });
  });
  test("handles mcp_result without approved_output, extracting text from result.content blocks", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      return JSON.stringify(
        event.event === "tool_result" && event.tool_call_id === "mcp_call"
          ? {
              decision: "mcp_result",
              result: {
                content: [
                  {
                    type: "text",
                    text: "Remedy executed successfully via MCP",
                  },
                ],
              },
            }
          : { decision: "ack" },
      );
    });
    const result = await processProxyResults({
      session,
      results: [
        {
          id: "mcp_call",
          name: "archestra__execute_remedy_plan",
          content: "{}",
          isError: false,
        },
      ],
    });
    expect(result.toolResultUpdates.mcp_call).toEqual({
      content: "Remedy executed successfully via MCP",
      outputSource: "tool",
    });
  });
  test("handles deliver_value, child_return, and refuse decisions", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.tool_call_id === "deliver_call") {
        return JSON.stringify({
          decision: "deliver_value",
          value: "admitted delivered value",
          output_source: "runtime",
        });
      }
      if (event.tool_call_id === "child_call") {
        return JSON.stringify({
          decision: "child_return",
          value: "child return value",
          output_source: "runtime",
        });
      }
      if (event.tool_call_id === "refuse_call") {
        return JSON.stringify({
          decision: "refuse",
          detail: "policy execution refused",
        });
      }
      return JSON.stringify({ decision: "ack" });
    });
    const result = await processProxyResults({
      session,
      results: [
        {
          id: "deliver_call",
          name: "calculate",
          content: "raw",
          isError: false,
        },
        { id: "child_call", name: "subagent", content: "raw", isError: false },
        { id: "refuse_call", name: "tool", content: "raw", isError: false },
      ],
    });
    expect(result.toolResultUpdates.deliver_call).toEqual({
      content: "admitted delivered value",
      outputSource: "runtime",
    });
    expect(result.toolResultUpdates.child_call).toEqual({
      content: "child return value",
      outputSource: "runtime",
    });
    expect(result.toolResultUpdates.refuse_call).toEqual({
      content: "policy execution refused",
      outputSource: "tool",
    });
  });
  test("fails closed with 503 when encountering an unknown decision type", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event === "tool_result") {
        return JSON.stringify({
          decision: "custom_future_decision_type",
        });
      }
      return JSON.stringify({ decision: "ack" });
    });
    await expect(
      processProxyResults({
        session,
        results: [
          {
            id: "future_call",
            name: "some_tool",
            content: "original output preserved",
            isError: false,
          },
        ],
      }),
    ).rejects.toThrow("OpenAPPA could not safely complete this operation");
  });
  test("keeps a structured cancellation indeterminate when processing proxy results", async () => {
    await processProxyResults({
      session,
      results: [
        {
          id: "cancelled",
          name: "read_file",
          content: "Partial output",
          isError: true,
          _meta: {
            archestraError: { type: "cancelled", message: "Stopped by user" },
          },
        },
      ],
    });
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

  test.each([
    false,
    true,
  ])("only a trusted Chat request can supply platform-seeded output (trusted=%s)", async (trustedChat) => {
    const content = JSON.stringify({
      _meta: { [SEEDED_APP_RENDER_META_KEY]: true },
      content: [
        { type: "text", text: "external payload with a copied marker" },
      ],
    });
    const result = await processProxyResults({
      session,
      trustedChat,
      results: [{ id: "seed", name: "render_app", content, isError: false }],
    });
    const reported = native.dispatchHook.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((event) => event.event === "tool_result");
    expect(reported).toHaveLength(trustedChat ? 0 : 1);
    if (!trustedChat) {
      expect(reported[0].output).toBe(content);
      expect(result.toolResultUpdates.seed.outputSource).toBe("runtime");
    }
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
  await processProxyResults({ session: scoped, results: [] });
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
  await processProxyResults({ session: scoped, results: [] });
  expect(native.dispatchHook).toHaveBeenLastCalledWith(
    expect.any(String),
    updated,
  );
});

describe("remedy by offer", () => {
  // An external client on the gateway names no session: Claude Code sends
  // nothing on an MCP call that identifies the session its proxy traffic ran
  // under, and static client config cannot supply one. Requiring it produced
  // "requires an authenticated session", which the model read as a bad offer
  // id and re-proposed the blocked call forever.
  test("resolves the session from the offer, scoped to the organization", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: { content: [{ type: "text", text: "[appa] Authorized." }] },
      }),
    );

    const result = await executeRemedyByOffer({
      organizationId: "org",
      toolCallId: "client-remedy-1",
      originalArguments: '{"offer_id":"offer-1"}',
      args: { offer_id: "offer-1" },
    });

    expect(result).toEqual({
      known: true,
      result: { content: [{ type: "text", text: "[appa] Authorized." }] },
    });
    expect(JSON.parse(native.executeRemedyByOffer.mock.calls[0][0])).toEqual({
      organization_id: "org",
      execution_mode: "tracked",
      tool_call_id: "client-remedy-1",
      original_arguments: '{"offer_id":"offer-1"}',
      arguments: { offer_id: "offer-1" },
      presentation: {
        control_tool: "archestra__execute_remedy_plan",
        supports_delegation: false,
      },
    });
  });

  test("fails closed when native omits the typed offer lookup discriminant", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        result: { content: [{ type: "text", text: "APPA remedy completed" }] },
      }),
    );

    await expect(
      executeRemedyByOffer({
        organizationId: "org",
        toolCallId: "client-remedy-2",
        originalArguments: '{"offer_id":"offer"}',
        args: { offer_id: "offer" },
      }),
    ).rejects.toThrow("OpenAPPA returned no offer lookup state");
  });

  test("rejects malformed native MCP resource content before forwarding it", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: {
          content: [
            {
              type: "resource",
              resource: { uri: "file:///missing-resource-body" },
            },
          ],
        },
      }),
    );

    await expect(
      executeRemedyByOffer({
        organizationId: "org",
        toolCallId: "client-remedy-malformed",
        originalArguments: '{"offer_id":"offer"}',
        args: { offer_id: "offer" },
      }),
    ).rejects.toThrow("OpenAPPA could not safely complete");
  });

  test("scopes a client-named session to its principal and keeps the room the header was promised", () => {
    // The header's own limit applies to the id as sent; the scope goes in
    // front of it afterwards, and the binding gives a scoped id more room.
    const long = "s".repeat(500);
    expect(
      sessionFromHeaders({
        headers: { "x-appa-session-id": long },
        organizationId: "org",
        callerId: "user:alice",
        scope: "user:alice",
      }),
    ).toMatchObject({ session_id: `user:alice|${long}` });
    // When no session header is sent, the fallback binds instead.
    expect(
      sessionFromHeaders({
        headers: {},
        organizationId: "org",
        fallbackSessionId: "user:alice@agent",
        scope: "user:alice",
      })?.session_id,
    ).toBe("user:alice@agent");
    // A header that is sent must still be well-formed, and its limit is in
    // bytes, as the runtime counts it.
    expect(() =>
      sessionFromHeaders({
        headers: { "x-appa-session-id": "bad\u0007session" },
        organizationId: "org",
      }),
    ).toThrow();
    expect(() =>
      sessionFromHeaders({
        headers: { "x-appa-session-id": "\u{1F600}".repeat(300) },
        organizationId: "org",
      }),
    ).toThrow();
  });

  test("returns an unknown offer's terminal result without selecting a session", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "unknown" },
        result: {
          isError: true,
          content: [
            { type: "text", text: "[appa] No live offer with this id" },
          ],
        },
      }),
    );

    const answer = await executeRemedyByOffer({
      organizationId: "org",
      toolCallId: "client-remedy-3",
      originalArguments: '{"offer_id":"offer-9"}',
      args: { offer_id: "offer-9" },
    });

    expect(answer.known).toBe(false);
    expect(answer.result).toMatchObject({ isError: true });
  });

  test("the gateway spends the durable offer owner without using the conversation", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: { content: [{ type: "text", text: "[appa] Authorized." }] },
      }),
    );

    const result = await executeArchestraTool(
      "archestra__execute_remedy_plan",
      { offer_id: "offer-1" },
      {
        agent: { id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7", name: "Chat" },
        agentId: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
        organizationId: "org",
        userId: "alice",
        conversationId: "conv-1",
        currentToolCallId: "remedy-4",
      },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "[appa] Authorized." }],
    });
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("does not run a conversation session when the offer is unknown", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "unknown" },
        result: {
          isError: true,
          content: [
            { type: "text", text: "[appa] No live offer with this id" },
          ],
        },
      }),
    );
    const result = await executeArchestraTool(
      "archestra__execute_remedy_plan",
      { offer_id: "offer-1" },
      {
        agent: { id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7", name: "Chat" },
        agentId: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
        organizationId: "org",
        userId: "alice",
        conversationId: "conv-1",
        currentToolCallId: "remedy-5",
      },
    );

    expect(native.dispatchHook).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "[appa] No live offer with this id" }],
    });
  });

  test("returns an unknown offer's terminal result when the client names no session", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "unknown" },
        result: {
          isError: true,
          content: [
            { type: "text", text: "[appa] No live offer with this id" },
          ],
        },
      }),
    );

    // The durable by-offer lookup needs no caller-selected session context.
    const result = await executeArchestraTool(
      "archestra__execute_remedy_plan",
      { offer_id: "offer-1" },
      {
        agent: { id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7", name: "Gateway" },
        agentId: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
        organizationId: "org",
        currentToolCallId: "remedy-1",
      },
    );

    expect(native.executeRemedyByOffer).toHaveBeenCalledTimes(1);
    expect(native.dispatchHook).not.toHaveBeenCalled();
    // The runtime's refusal reaches the model verbatim, error flag intact.
    expect(result).toMatchObject({ isError: true });
  });

  test("executes an untracked remedy without inventing a receipt identity", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "unknown" },
        result: {
          isError: true,
          content: [
            { type: "text", text: "[appa] No live offer with this id" },
          ],
        },
      }),
    );
    const result = await executeArchestraTool(
      "archestra__execute_remedy_plan",
      { offer_id: "offer-1" },
      {
        agent: {
          id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
          name: "Gateway",
        },
        agentId: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
        organizationId: "org",
      },
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.parse(native.executeRemedyByOffer.mock.calls[0][0])).toEqual({
      organization_id: "org",
      execution_mode: "untracked",
      original_arguments: '{"offer_id":"offer-1"}',
      arguments: { offer_id: "offer-1" },
      presentation: {
        control_tool: "archestra__execute_remedy_plan",
        supports_delegation: false,
      },
    });
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("names the authenticated caller, so an offer is spent only by the caller it was minted for", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: { content: [{ type: "text", text: "[appa] Authorized." }] },
      }),
    );

    await executeArchestraTool(
      "archestra__execute_remedy_plan",
      { offer_id: "offer-1" },
      {
        agent: { id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7", name: "Gateway" },
        agentId: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
        organizationId: "org",
        userId: "alice",
        currentToolCallId: "remedy-3",
      },
    );

    // The proxy names a person as `user:<id>` when it mints the offer; the
    // gateway names the same person the same way when it spends it.
    expect(JSON.parse(native.executeRemedyByOffer.mock.calls[0][0])).toEqual({
      organization_id: "org",
      caller_id: "user:alice",
      execution_mode: "tracked",
      tool_call_id: "remedy-3",
      original_arguments: '{"offer_id":"offer-1"}',
      arguments: { offer_id: "offer-1" },
      presentation: {
        control_tool: "archestra__execute_remedy_plan",
        supports_delegation: false,
      },
    });
  });

  test("keeps the informational plan out of what the runtime executes", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: { content: [{ type: "text", text: "[appa] Authorized." }] },
      }),
    );

    // `plan` says what the remedy does, for the transcript and for any
    // client-side judge reading the call; runtime options come from the visible
    // semantic arguments, never the transport record.
    const result = await executeArchestraTool(
      "archestra__execute_remedy_plan",
      {
        offer_id: "offer-1",
        plan: "accept the policy's restriction on this session's readers",
        execution: {
          v: 1,
          kind: "appa_remedy",
          call_id: "provider-control-2",
          tool_name: "archestra__execute_remedy_plan",
          original_arguments:
            '{"offer_id":"offer-1","plan":"accept the policy\'s restriction on this session\'s readers"}',
        },
      },
      {
        agent: { id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7", name: "Gateway" },
        agentId: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
        organizationId: "org",
        currentToolCallId: "remedy-2",
      },
    );
    expect(result.content).toEqual([
      { type: "text", text: "[appa] Authorized." },
    ]);

    expect(JSON.parse(native.executeRemedyByOffer.mock.calls[0][0])).toEqual({
      organization_id: "org",
      execution_mode: "tracked",
      tool_call_id: "provider-control-2",
      original_arguments:
        '{"offer_id":"offer-1","plan":"accept the policy\'s restriction on this session\'s readers"}',
      arguments: { offer_id: "offer-1" },
      presentation: {
        control_tool: "archestra__execute_remedy_plan",
        supports_delegation: false,
      },
    });
  });

  test.each([
    {
      field: "label",
      original: { label: { trust: "trusted" } },
      submitted: { label: { trust: "untrusted" } },
    },
    {
      field: "audience",
      original: { label: { audience: ["internal"] } },
      submitted: { label: { audience: ["external"] } },
    },
    {
      field: "return schema",
      original: { return_schema: { type: "string" } },
      submitted: { return_schema: { type: "object" } },
    },
    {
      field: "plan",
      original: { plan: "narrow readers" },
      submitted: { plan: "expand readers" },
    },
  ])("rejects execution metadata that changes $field before native execution", async ({
    original,
    submitted,
  }) => {
    await expect(
      executeArchestraTool(
        "archestra__execute_remedy_plan",
        {
          offer_id: "offer-1",
          ...submitted,
          execution: {
            v: 1,
            kind: "appa_remedy",
            call_id: "provider-control",
            tool_name: "archestra__execute_remedy_plan",
            original_arguments: JSON.stringify({
              offer_id: "offer-1",
              ...original,
            }),
          },
        },
        {
          agent: { id: "agent", name: "Gateway" },
          organizationId: "org",
          userId: "alice",
        },
      ),
    ).rejects.toThrow("execution arguments do not match");
    expect(native.executeRemedyByOffer).not.toHaveBeenCalled();
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("accepts equivalent semantic arguments while carrying the real call and display identities", async () => {
    native.executeRemedyByOffer.mockResolvedValueOnce(
      JSON.stringify({
        decision: "mcp_result",
        offer: { status: "known" },
        result: { content: [{ type: "text", text: "Applied" }] },
      }),
    );
    const originalArguments =
      '{ "return_schema": { "properties": { "b": {}, "a": {} }, "type": "object" }, "offer_id": "offer-1" }';
    await executeArchestraTool(
      "archestra__execute_remedy_plan",
      {
        offer_id: "offer-1",
        return_schema: { type: "object", properties: { a: {}, b: {} } },
        execution: {
          v: 1,
          kind: "appa_remedy",
          call_id: "provider-control",
          tool_name: "mcp__gateway__archestra__execute_remedy_plan",
          original_arguments: originalArguments,
        },
      },
      {
        agent: { id: "agent", name: "Gateway" },
        organizationId: "org",
        userId: "alice",
      },
    );
    expect(
      JSON.parse(native.executeRemedyByOffer.mock.calls[0][0]),
    ).toMatchObject({
      tool_call_id: "provider-control",
      original_arguments: originalArguments,
      arguments: {
        offer_id: "offer-1",
        return_schema: { type: "object", properties: { a: {}, b: {} } },
      },
      presentation: {
        control_tool: "mcp__gateway__archestra__execute_remedy_plan",
        supports_delegation: false,
      },
    });
  });
});
