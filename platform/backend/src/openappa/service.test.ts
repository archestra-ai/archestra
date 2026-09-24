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
import { signOfferClaims, unsignedOfferClaims } from "./offer-claims";
import {
  approveSpawnReturn,
  cancelCalls,
  endChild,
  evaluateHostedToolCalls,
  evaluateToolCalls,
  executeRemedyByOffer,
  loadOfferReview,
  processProxyResults,
  sessionFromHeaders,
} from "./service";

function signedRemedyArgs(offerId = "offer-1") {
  const jws = signOfferClaims(
    unsignedOfferClaims({
      organizationId,
      sessionId: "conversation",
      callerId: "user:alice",
      offerId,
    }),
    "test-offer-signing-secret-32chars",
  );
  return { offer_id: offerId, ...jws };
}

const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(),
  dispatchHook: vi.fn(),
  executeRemedyByOffer: vi.fn(),
  loadOfferReview: vi.fn(),
  // No batteries declared: the composed policy is the root alone.
  listBundledOpenappaBatteries: vi.fn(async () => []),
  parseOpenappaDeclarations: vi.fn(async () => ({
    include: [],
    serverAliases: [],
    credentials: [],
    routedAnnotators: [],
    errors: [],
  })),
  composeOpenappaPolicy: vi.fn(async (input: { root: string }) => ({
    content: input.root,
    errors: [],
  })),
}));
vi.mock("@archestra/openappa-rs", () => native);
vi.mock("@/logging");
// The effective-policy store foreign-keys the organization: a real row must
// exist for every organization_id the sessions below name.
let organizationId = "org";

const session = {
  get organization_id() {
    return organizationId;
  },
  caller_id: "user:alice",
  session_id: "conversation",
};

beforeEach(async ({ makeOrganization }) => {
  organizationId = (await makeOrganization()).id;
  config.llmProxy.plugins = ["appa"];
  config.openappa = {
    enabled: true,
    yellEnabled: false,
    offerSigningSecret: "test-offer-signing-secret-32chars",
    postgresMaxConnections: 10,
  };
  await GuardrailsDeploymentModel.setEnabled(true);
  vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
    "postgresql://test:test@localhost/test",
  );
  native.loadOfferReview.mockReset();
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
          organizationId,
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

  test("a turn that began while enabled finishes after the switch turns off", async () => {
    // The proxy read the switch when this request began. Turning it off
    // mid-request must not fail the turn it already governs.
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "allow_call" }),
    );
    await GuardrailsDeploymentModel.setEnabled(false);

    const decisions = await evaluateToolCalls(
      session,
      [{ id: "first", name: "read_file", arguments: {} }],
      { canonicalize: (name) => name },
    );

    expect(decisions).toEqual([{ kind: "allow" }]);
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
      organizationId,
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
        organizationId,
        userId: "alice",
      }),
    ).rejects.toThrow("requires an authenticated session");
    const parent = "a637fb55-989b-4f01-a251-e7e277c65f05";
    const child = "3c0f2458-f26a-4b05-9571-a64dca1d65a7";
    await expect(
      executeArchestraTool("archestra__yell", args, {
        agent: { id: child, name: "Child" },
        delegationChain: `${parent}:${child}`,
        organizationId,
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
      {
        kind: "deny",
        feedback: "[appa] a call is already outstanding",
        offers: [],
      },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(
        ([raw]) => JSON.parse(raw).operation_id,
      ),
    ).toEqual(["call:first", "call:second"]);
  });

  test("holds what a provider-run call brought in behind the runtime's staged ruling", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      return JSON.stringify(
        event.event === "tool_result"
          ? {
              decision: "replace_output",
              approved_output: "[appa] staged; accept offer-7",
              output_source: "runtime",
            }
          : { decision: "allow_call" },
      );
    });

    const decisions = await evaluateHostedToolCalls(
      session,
      [
        {
          id: "ws_1",
          name: "web_search",
          arguments: { query: "rust" },
          output: "search tail",
        },
      ],
      { canonicalize: (name) => name },
    );

    expect(decisions).toEqual([
      { kind: "hold", feedback: "[appa] staged; accept offer-7" },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => {
        const { event, operation_id, tool_call_id, output } = JSON.parse(raw);
        return { event, operation_id, tool_call_id, output };
      }),
    ).toEqual([
      { event: "tool_call", operation_id: "call:ws_1" },
      { event: "tool_result", tool_call_id: "ws_1", output: "search tail" },
    ]);
  });

  test("releases a provider-run result the runtime admits unchanged", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) =>
      JSON.stringify(
        JSON.parse(raw).event === "tool_result"
          ? { decision: "ack" }
          : { decision: "allow_call" },
      ),
    );

    expect(
      await evaluateHostedToolCalls(
        session,
        [{ id: "ws_1", name: "web_search", arguments: {}, output: "tail" }],
        { canonicalize: (name) => name },
      ),
    ).toEqual([{ kind: "release" }]);
  });

  test("a provider-run call the policy denies is held without submitting its result", async () => {
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({
        decision: "deny_call",
        feedback: "[appa] trust would fall; accept offer-9",
      }),
    );

    expect(
      await evaluateHostedToolCalls(
        session,
        [{ id: "ws_1", name: "web_search", arguments: {}, output: "tail" }],
        { canonicalize: (name) => name },
      ),
    ).toEqual([
      { kind: "hold", feedback: "[appa] trust would fall; accept offer-9" },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw).event),
    ).toEqual(["tool_call"]);
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
      ).toEqual([
        "tool_call",
        "tool_call",
        "tool_call",
        "cancel_call",
        "cancel_call",
      ]);
    } else {
      expect(await check).toEqual([
        { kind: "allow" },
        { kind: "deny", feedback: "Policy denied", offers: [] },
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
        control: { name: "mcp__archestra__execute_remedy_plan" },
      },
    );

    expect(decisions).toEqual([{ kind: "control" }]);
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("releases ask_user without evaluating it against the policy", async () => {
    const decisions = await evaluateToolCalls(
      session,
      [
        {
          id: "ask-call",
          name: "mcp__archestra__ask_user",
          arguments: {
            question: "Accept for this session?",
            options: [
              { label: "Accept for this session" },
              { label: "Do not accept" },
            ],
          },
        },
      ],
      { canonicalize: (name) => name.replace(/^mcp__/, "") },
    );

    expect(decisions).toEqual([{ kind: "allow" }]);
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test.each([
    // A branded name alone is not proof that the proxy emitted a question.
    { name: "mcp__archestra__ask_user", reported: true, localQuestion: false },
    // Nor on a client's own question tool, which asks the same way.
    { name: "AskUserQuestion", reported: false, localQuestion: true },
    { name: "request_user_input", reported: false, localQuestion: true },
    { name: "question", reported: false, localQuestion: true },
    // Another server's tool of the same name is an ordinary governed tool.
    { name: "mcp__other__ask_user", reported: true, localQuestion: false },
    { name: "request_user_input", reported: true, localQuestion: false },
    { name: "question", reported: true, localQuestion: false },
  ])("reports a $name result to the runtime: $reported", async ({
    name,
    reported,
    localQuestion,
  }) => {
    const answer = "The user picked: Accept for this session.";

    const result = await processProxyResults({
      session,
      canonicalize: (each) => each.replace(/^mcp__/, ""),
      ...(localQuestion
        ? { isUserQuestion: (each: { name: string }) => each.name === name }
        : {}),
      results: [{ id: "ask-call", name, content: answer, isError: false }],
    });

    const events = native.dispatchHook.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((event) => event.event === "tool_result");
    expect(events).toHaveLength(reported ? 1 : 0);
    expect(result.toolResultUpdates["ask-call"]?.content).toBe(
      reported ? "APPA: withheld; remedy offer-123" : undefined,
    );
  });

  test("does not exempt an unrelated MCP question from tool-call evaluation", async () => {
    await evaluateToolCalls(
      session,
      [{ id: "foreign-question", name: "question", arguments: {} }],
      {
        canonicalize: (name) => name,
        isUserQuestion: () => false,
      },
    );
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw)),
    ).toContainEqual(
      expect.objectContaining({ event: "tool_call", tool: "question" }),
    );
    native.dispatchHook.mockClear();
    expect(
      await evaluateToolCalls(
        session,
        [{ id: "native-question", name: "question", arguments: {} }],
        {
          canonicalize: (name) => name,
          isUserQuestion: (name) => name === "question",
        },
      ),
    ).toEqual([{ kind: "allow" }]);
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("releases the control call only in the namespace its tool was declared in", async () => {
    // Codex calls a namespace member by its bare name. A server beside the
    // gateway can declare a member spelled like the control tool; its call is
    // an ordinary tool call, evaluated like any other.
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "deny_call", feedback: "Not declared" }),
    );
    const call = (id: string, namespace: string) => ({
      id,
      name: "archestra__execute_remedy_plan",
      namespace,
      arguments: { offer_id: "offer-1" },
    });
    const decisions = await evaluateToolCalls(
      session,
      [call("ours", "mcp__gw"), call("foreign", "mcp__evil")],
      {
        canonicalize: (name, namespace) =>
          namespace ? `${namespace}__${name}` : name,
        control: {
          name: "archestra__execute_remedy_plan",
          namespace: "mcp__gw",
        },
      },
    );

    expect(decisions).toEqual([
      { kind: "control" },
      { kind: "deny", feedback: "Not declared", offers: [] },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw)),
    ).toEqual([
      expect.objectContaining({
        event: "tool_call",
        operation_id: "call:foreign",
        tool: "mcp__evil__archestra__execute_remedy_plan",
        spelling: "archestra__execute_remedy_plan",
      }),
    ]);
  });

  test("evaluates a foreign ask_user instead of granting platform-question access", async () => {
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "deny_call", feedback: "Not declared" }),
    );
    const decisions = await evaluateToolCalls(
      session,
      [
        {
          id: "trusted-question",
          name: "archestra__ask_user",
          namespace: "mcp__gateway",
          arguments: {},
        },
        {
          id: "foreign-question",
          name: "archestra__ask_user",
          namespace: "mcp__foreign",
          arguments: {},
        },
      ],
      {
        canonicalize: (name) => name,
        isUserQuestion: (name, namespace) =>
          name === "archestra__ask_user" && namespace === "mcp__gateway",
      },
    );
    expect(decisions).toEqual([
      { kind: "allow" },
      { kind: "deny", feedback: "Not declared", offers: [] },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw)),
    ).toEqual([
      expect.objectContaining({
        event: "tool_call",
        operation_id: "call:foreign-question",
      }),
    ]);
  });

  test.each([
    undefined,
    "mcp__evil",
  ])("evaluates an unregistered remedy lookalike (%s)", async (namespace) => {
    // The gateway canonicalizer only resolves namespaces it attests; a
    // foreign server's member stays a bare leaf name. The leaf alone must
    // never release remedy control: the call carries a namespace, so it is
    // evaluated like any foreign tool.
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "deny_call", feedback: "Not declared" }),
    );
    const decisions = await evaluateToolCalls(
      session,
      [
        {
          id: "lookalike",
          name: "archestra__execute_remedy_plan",
          namespace,
          arguments: { offer_id: "offer-1" },
        },
      ],
      {
        canonicalize: (name) => name,
        control: {
          name: "archestra__execute_remedy_plan",
          namespace: "mcp__gw",
        },
      },
    );

    expect(decisions).toEqual([
      { kind: "deny", feedback: "Not declared", offers: [] },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw)),
    ).toEqual([
      expect.objectContaining({
        event: "tool_call",
        operation_id: "call:lookalike",
        tool: "archestra__execute_remedy_plan",
      }),
    ]);
  });

  test("announces a spawn tool so the runtime can open a child branch", async () => {
    native.dispatchHook.mockResolvedValue(
      JSON.stringify({ decision: "allow_call", spawn_binding: "fork-1" }),
    );
    expect(
      await evaluateToolCalls(
        session,
        [{ id: "spawn", name: "spawn_agent", arguments: { message: "Go" } }],
        {
          canonicalize: (name) => name,
          isSpawn: (name) => name === "spawn_agent",
          supportsDelegation: true,
        },
      ),
    ).toEqual([{ kind: "allow" }]);
    expect(
      JSON.parse(native.dispatchHook.mock.calls.at(-1)?.[0] ?? "{}"),
    ).toMatchObject({
      event: "tool_call",
      tool: "spawn_agent",
      spawn: true,
      presentation: { supports_delegation: true },
    });
  });

  test.each([
    "allow_call",
    "pass_control",
  ] as const)("does not release a spawn without a fork binding (%s)", async (decision) => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      return JSON.stringify({
        decision: event.event === "tool_call" ? decision : "ack",
      });
    });

    const decisions = await evaluateToolCalls(
      session,
      [{ id: "spawn", name: "spawn_agent", arguments: { message: "Go" } }],
      {
        canonicalize: (name) => name,
        isSpawn: (name) => name === "spawn_agent",
        supportsDelegation: true,
      },
    );

    expect(decisions).toEqual([
      {
        kind: "deny",
        feedback: expect.stringContaining("context_control"),
      },
    ]);
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw)),
    ).toEqual(
      decision === "allow_call"
        ? [
            expect.objectContaining({ event: "tool_call", spawn: true }),
            expect.objectContaining({
              event: "cancel_call",
              tool_call_id: "spawn",
            }),
          ]
        : [expect.objectContaining({ event: "tool_call", spawn: true })],
    );
  });

  test("keeps a successful spawn launch pending until the child binds", async () => {
    native.dispatchHook.mockResolvedValue(JSON.stringify({ decision: "ack" }));
    const result = await processProxyResults({
      session,
      canonicalize: (name) => name,
      classifySpawnResult: (answer) =>
        answer.name === "spawn_agent" ? "pending" : undefined,
      results: [
        {
          id: "spawn",
          name: "spawn_agent",
          content: '{"agent_id":"child-1"}',
          isError: false,
        },
      ],
    });
    expect(result.toolResultUpdates).toEqual({});
    expect(
      native.dispatchHook.mock.calls.map((call) => JSON.parse(call[0] ?? "{}")),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "tool_result" }),
      ]),
    );
  });

  test("reports a failed spawn launch so the runtime closes its prepared fork", async () => {
    native.dispatchHook.mockResolvedValue(JSON.stringify({ decision: "ack" }));
    await processProxyResults({
      session,
      canonicalize: (name) => name,
      classifySpawnResult: (answer) =>
        answer.name === "spawn_agent" ? "failed" : undefined,
      results: [
        {
          id: "spawn",
          name: "spawn_agent",
          content: "client rejected the spawn arguments",
          isError: false,
        },
      ],
    });
    expect(
      native.dispatchHook.mock.calls.map((call) => JSON.parse(call[0] ?? "{}")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "tool_result",
          tool_call_id: "spawn",
          outcome: "failure",
        }),
      ]),
    );
  });

  test("echoes the runtime's canonical ChildReturn before exposing it", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      return JSON.stringify(
        event.operation_id === "child_end:turn:echo"
          ? { decision: "ack" }
          : {
              decision: "child_return",
              value: "SUMMARY(24 characters): safe",
              output_source: "runtime",
            },
      );
    });
    const child = {
      ...session,
      session_id: "conversation:child",
      parent_id: session.session_id,
    };

    await expect(
      endChild({
        session: child,
        operationId: "child_end:turn",
        output: "REPORT-RAW-KOALA-0831",
      }),
    ).resolves.toEqual({
      decision: "replace",
      content: "SUMMARY(24 characters): safe",
      crossed: true,
    });
    expect(
      native.dispatchHook.mock.calls.map(([raw]) => JSON.parse(raw)),
    ).toEqual([
      {
        ...child,
        event: "child_end",
        operation_id: "child_end:turn",
        output: "REPORT-RAW-KOALA-0831",
      },
      {
        ...child,
        event: "child_end",
        operation_id: "child_end:turn:echo",
        output: "SUMMARY(24 characters): safe",
      },
    ]);
  });

  test("releases an unchanged child return and renders a blocked one safely", async () => {
    const child = {
      ...session,
      session_id: "conversation:child",
      parent_id: session.session_id,
    };
    native.dispatchHook.mockResolvedValueOnce(
      JSON.stringify({ decision: "ack" }),
    );
    await expect(
      endChild({
        session: child,
        operationId: "child_end:clean",
        output: "ok",
      }),
    ).resolves.toEqual({ decision: "release", crossed: true });

    native.dispatchHook.mockResolvedValueOnce(
      JSON.stringify({ decision: "block", feedback: "Return withheld" }),
    );
    await expect(
      endChild({
        session: child,
        operationId: "child_end:blocked",
        output: "secret",
      }),
    ).resolves.toEqual({
      decision: "replace",
      content: "Return withheld",
      crossed: false,
    });
  });

  test("fails closed when ChildEnd is refused or cannot be correlated", async () => {
    native.dispatchHook.mockResolvedValueOnce(
      JSON.stringify({ decision: "refuse", detail: "internal detail" }),
    );
    const child = {
      ...session,
      session_id: "conversation:child",
      parent_id: session.session_id,
    };
    await expect(
      endChild({
        session: child,
        operationId: "child_end:refused",
        output: "secret",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(
      endChild({
        session,
        operationId: "child_end:root",
        output: "secret",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("submits the exact crossed child value as the parent SpawnResult", async () => {
    native.dispatchHook.mockResolvedValueOnce(
      JSON.stringify({ decision: "ack" }),
    );

    await approveSpawnReturn({
      session,
      toolCallId: "spawn-call",
      childId: "conversation:child",
      value: "SUMMARY(24 characters): safe",
    });

    expect(JSON.parse(native.dispatchHook.mock.calls[0][0])).toEqual({
      ...session,
      event: "tool_result",
      tool_call_id: "spawn-call",
      spawned_id: "conversation:child",
      output: "SUMMARY(24 characters): safe",
      outcome: "success",
    });
  });

  test("fails closed when SpawnResult does not attest the crossed bytes", async () => {
    native.dispatchHook.mockResolvedValueOnce(
      JSON.stringify({
        decision: "child_return",
        value: "different bytes",
      }),
    );

    await expect(
      approveSpawnReturn({
        session,
        toolCallId: "spawn-call",
        childId: "conversation:child",
        value: "SUMMARY(24 characters): safe",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
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
      { kind: "deny", feedback: "Parent policy denied", offers: [] },
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
          organizationId,
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
    await expect(
      processProxyResults({
        session,
        results: [],
        canonicalize: (name) => name,
      }),
    ).rejects.toThrow("OpenAPPA could not safely complete");
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
          organizationId,
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
      signedRemedyArgs("offer"),
      {
        agent: { id: "agent", name: "Assistant" },
        agentId: "agent",
        organizationId,
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
      organizationId,
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
      signedRemedyArgs("human-offer"),
      {
        agent: { id: "agent", name: "Assistant" },
        agentId: "agent",
        organizationId,
        userId: "alice",
        sessionId: "conversation",
        currentToolCallId: "remedy-call-2",
        elicitation: { elicit },
      },
    );
    expect(result).toMatchObject(appaResult);
    expect(elicit).not.toHaveBeenCalled();
    expect(native.dispatchHook).not.toHaveBeenCalled();
  });

  test("admits the first client result without Chat execution reporting", async () => {
    const result = await processProxyResults({
      session,
      canonicalize: (name: string) => name,
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
  test("refuses a session whose return contract the proxy cannot deliver before inference", async () => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      return JSON.stringify(
        event.event === "session_start"
          ? {
              decision: "context",
              text: "[appa] Your final message is checked when you stop: it must be one JSON object matching this schema.",
            }
          : { decision: "ack" },
      );
    });
    await expect(
      processProxyResults({
        session: { ...session, parent_id: "parent" },
        canonicalize: (name: string) => name,
        results: [
          {
            id: "call",
            name: "read_file",
            content: "RAW RESULT",
            isError: false,
          },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // The refusal happens at session start: no tool result reaches the runtime.
    expect(
      native.dispatchHook.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .filter((event) => event.event === "tool_result"),
    ).toHaveLength(0);
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
      canonicalize: (name: string) => name,
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
      canonicalize: (name: string) => name,
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
      canonicalize: (name: string) => name,
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
      canonicalize: (name: string) => name,
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
      canonicalize: (name: string) => name,
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
      canonicalize: (name: string) => name,
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
        canonicalize: (name: string) => name,
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
      canonicalize: (name: string) => name,
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
      canonicalize: (name: string) => name,
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
  await processProxyResults({
    session: scoped,
    results: [],
    canonicalize: (name) => name,
  });
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
  await processProxyResults({
    session: scoped,
    results: [],
    canonicalize: (name) => name,
  });
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
      organizationId,
      sessionId: "session",
      toolCallId: "client-remedy-1",
      originalArguments: '{"offer_id":"offer-1"}',
      args: { offer_id: "offer-1" },
    });

    expect(result).toEqual({
      known: true,
      result: { content: [{ type: "text", text: "[appa] Authorized." }] },
    });
    expect(JSON.parse(native.executeRemedyByOffer.mock.calls[0][0])).toEqual({
      organization_id: organizationId,
      session_id: "session",
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
        organizationId,
        sessionId: "session",
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
        organizationId,
        sessionId: "session",
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
        organizationId,
        callerId: "user:alice",
        scope: "user:alice",
      }),
    ).toMatchObject({ session_id: `user:alice|${long}` });
    // When no session header is sent, the fallback binds instead.
    expect(
      sessionFromHeaders({
        headers: {},
        organizationId,
        fallbackSessionId: "user:alice@agent",
        scope: "user:alice",
      })?.session_id,
    ).toBe("user:alice@agent");
    // A header that is sent must still be well-formed, and its limit is in
    // bytes, as the runtime counts it.
    expect(() =>
      sessionFromHeaders({
        headers: { "x-appa-session-id": "bad\u0007session" },
        organizationId,
      }),
    ).toThrow();
    expect(() =>
      sessionFromHeaders({
        headers: { "x-appa-session-id": "\u{1F600}".repeat(300) },
        organizationId,
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
      organizationId,
      sessionId: "session",
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
      signedRemedyArgs(),
      {
        agent: { id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7", name: "Chat" },
        agentId: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
        organizationId,
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
        organizationId,
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

  test("returns an unknown offer's terminal result when the client names no signed claims", async () => {
    const result = await executeArchestraTool(
      "archestra__execute_remedy_plan",
      { offer_id: "offer-1" },
      {
        agent: { id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7", name: "Gateway" },
        agentId: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
        organizationId,
        currentToolCallId: "remedy-1",
      },
    );

    expect(native.executeRemedyByOffer).not.toHaveBeenCalled();
    expect(native.dispatchHook).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "[appa] No live offer with this id" }],
    });
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
      signedRemedyArgs(),
      {
        agent: {
          id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
          name: "Gateway",
        },
        agentId: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
        organizationId,
      },
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.parse(native.executeRemedyByOffer.mock.calls[0][0])).toEqual({
      organization_id: organizationId,
      session_id: "conversation",
      owner_caller_id: "user:alice",
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
      signedRemedyArgs(),
      {
        agent: { id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7", name: "Gateway" },
        agentId: "3c0f2458-f26a-4b05-9571-a64dca1d65a7",
        organizationId,
        userId: "alice",
        currentToolCallId: "remedy-3",
      },
    );

    // The proxy names a person as `user:<id>` when it mints the offer; the
    // gateway names the same person the same way when it spends it.
    expect(JSON.parse(native.executeRemedyByOffer.mock.calls[0][0])).toEqual({
      organization_id: organizationId,
      session_id: "conversation",
      caller_id: "user:alice",
      owner_caller_id: "user:alice",
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

  // The host half of the precheck contract: the review's call comes back from
  // the binding, and the refusal goes to it in place of a ruling. The binding
  // half (recorded verbatim, offer left unspent) is pinned in smoke.test.cjs.
  test("records a precheck refusal instead of asking about a reviewed call that could not run", async () => {
    native.loadOfferReview.mockResolvedValueOnce({
      offerId: "offer-1",
      text: "Approve this todo?",
      sessionId: "conversation",
      tool: "archestra__todo_write",
      arguments: '{"todos":[{"content":"qa-hitl","status":"pending"}]}',
    });
    const elicit = vi.fn();

    await executeArchestraTool(
      "archestra__execute_remedy_plan",
      signedRemedyArgs(),
      {
        agent: { id: "3c0f2458-f26a-4b05-9571-a64dca1d65a7", name: "Chat" },
        organizationId,
        userId: "alice",
        currentToolCallId: "remedy-6",
        elicitation: { elicit },
      },
    );

    expect(native.loadOfferReview).toHaveBeenCalledWith(
      organizationId,
      "conversation",
      "offer-1",
    );
    expect(elicit).not.toHaveBeenCalled();
    const input = JSON.parse(native.executeRemedyByOffer.mock.calls[0][0]);
    expect(input).not.toHaveProperty("ruling");
    expect(input.precheck_refusal).toMatch(
      /^\[appa\] Not submitted for approval: this call to archestra__todo_write could not run even if approved\.\n.*todos\[0\]\.id/,
    );
  });

  test("fails closed with 503 when the offer review cannot be loaded", async () => {
    native.loadOfferReview.mockRejectedValueOnce(
      new Error("host SQL requires a leased connection"),
    );
    await expect(
      loadOfferReview({
        organizationId,
        sessionId: "conversation",
        offerId: "offer-1",
      }),
    ).rejects.toThrow("OpenAPPA could not safely complete this operation");
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
        ...signedRemedyArgs(),
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
        organizationId,
        currentToolCallId: "remedy-2",
      },
    );
    expect(result.content).toEqual([
      { type: "text", text: "[appa] Authorized." },
    ]);

    expect(JSON.parse(native.executeRemedyByOffer.mock.calls[0][0])).toEqual({
      organization_id: organizationId,
      session_id: "conversation",
      owner_caller_id: "user:alice",
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
          organizationId,
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
        ...signedRemedyArgs(),
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
        organizationId,
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
