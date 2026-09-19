import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import * as appaService from "@/openappa/service";
import type { LlmProxyRequestContext } from "@/proxy/plugins/registry";
import { describe, expect, test, vi } from "@/test";
import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";
import { APPA_PLUGIN_TRUSTED_CONTEXT } from "./types";

describe("APPA client adapters", () => {
  test("maps each integrated client to its real local tool namespace", () => {
    const chat = new AppaChatAdapter();
    const claudeCode = new AppaClaudeCodeAdapter();
    const codex = new AppaCodexAdapter();
    const openCode = new AppaOpenCodeAdapter();

    expect(
      chat.matches({
        headers: {},
        requestBody: {},
        trustedContext: {
          session: {
            organization_id: "org",
            caller_id: "user:user",
            session_id: "conversation",
          },
          profileId: "profile",
          canonicalizeToolName: (name) => name,
          request: {
            tools: undefined,
            session: {},
            spellings: new Map(),
            customTools: new Set(),
            namespaces: new Map(),
          },
          chatSource: "chat:tool_call_repair",
        },
      }),
    ).toBe(true);
    expect(chat.classifyToolName("archestra__run_command")).toBe("gateway");
    expect(chat.normalizeLocalToolName("read_file")).toBe("read_file");

    expect(
      claudeCode.matches({
        headers: { "User-Agent": "Claude-Code/1" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(
      codex.matches({
        headers: { originator: "codex" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(
      openCode.matches({
        headers: { "x-opencode-session": "s" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(claudeCode.normalizeLocalToolName("host/claude-code/Bash")).toBe(
      "host/claude-code/Bash",
    );
    expect(codex.normalizeLocalToolName("functions.exec_command")).toBe(
      "builtin:exec_command",
    );
    expect(codex.normalizeLocalToolName("functions.builtin:read_file")).toBe(
      "builtin:read_file",
    );
    expect(openCode.normalizeLocalToolName("read_file")).toBe(
      "builtin:read_file",
    );
    expect(openCode.classifyToolName("mcp:gateway:read")).toBe("gateway");
    expect(claudeCode.classifyToolName("mcp__gateway__read")).toBe("gateway");
    expect(claudeCode.classifyToolName("Bash")).toBe("local");
  });
});

describe("AppaPluginArchestra", () => {
  test("keeps bindings private to each request and deletes them at cleanup", async () => {
    const canonicalizedNames: string[] = [];
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async (_session, calls, options) => {
        canonicalizedNames.push(options.canonicalize("read_file"));
        return calls.map(() => ({ kind: "allow" }) as const);
      });
    const plugin = new AppaPluginArchestra([
      {
        id: "test-adapter",
        matches: () => true,
        classifyToolName: () => "local",
        normalizeLocalToolName: (name) => `local:${name}`,
      },
    ]);
    const first = requestContext({
      sessionId: "first-session",
      canonicalizeToolName: (name) => `first:${name}`,
    });
    const second = requestContext({
      sessionId: "second-session",
      canonicalizeToolName: (name) => `second:${name}`,
    });

    try {
      await plugin.onSessionInit(first);
      await plugin.onSessionInit(second);
      // A later plugin shares this resources map and can overwrite the trusted
      // context in it. APPA copied its binding when the session opened, so the
      // overwrite reaches nothing it relies on.
      first.resources.set(APPA_PLUGIN_TRUSTED_CONTEXT, {
        session: {
          organization_id: "other-organization",
          caller_id: "user:other",
          session_id: "other-session",
        },
        profileId: "other-profile",
        canonicalizeToolName: () => "overwritten",
        request: {
          tools: undefined,
          spellings: new Map(),
          customTools: new Set(),
          namespaces: new Map(),
        },
      });

      await plugin.onToolCalls({
        ...first,
        toolCalls: [{ id: "first-call", name: "read_file", arguments: {} }],
      });
      await plugin.onToolCalls({
        ...second,
        toolCalls: [{ id: "second-call", name: "read_file", arguments: {} }],
      });

      expect(canonicalizedNames).toEqual([
        "first:local:read_file",
        "second:local:read_file",
      ]);
      expect(
        evaluateToolCalls.mock.calls.map(([session]) => session.session_id),
      ).toEqual(["first-session", "second-session"]);

      await plugin.onCleanup(first);
      await expect(
        plugin.onToolCalls({
          ...first,
          toolCalls: [{ id: "cleaned-call", name: "read_file", arguments: {} }],
        }),
      ).resolves.toBeUndefined();
      expect(evaluateToolCalls).toHaveBeenCalledTimes(2);
    } finally {
      evaluateToolCalls.mockRestore();
    }
  });
});

describe("rendering runtime text for this client", () => {
  test("refuses the turn, with the ruling, when a denied call has no notice tool to carry it", async () => {
    // A request that declared no tools opened no notice tool, and a call
    // arrived anyway: Codex's code mode runs its tools out of band and sends
    // them as programs. Nothing can carry the ruling as a notice, so the turn
    // ends with the ruling as text instead of failing mid-stream.
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "toolless-session",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: undefined,
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
    };
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async () => [
        {
          kind: "deny" as const,
          feedback:
            "[appa] Refused: tool builtin:exec is not declared in this policy",
          offers: [],
        },
      ]);
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolCalls({
        ...context,
        toolCalls: [{ id: "call", name: "exec", arguments: { input: "..." } }],
      });
      expect(outcome).toMatchObject({
        decision: "refuse",
        refusal: {
          reason: "openappa_no_notice_tool",
          blockedToolName: "exec",
          blockedToolId: "call",
          allToolCallNames: ["exec"],
        },
      });
      const message = (outcome as { refusal: { contentMessage: string } })
        .refusal.contentMessage;
      expect(message).toContain("[appa] Refused: tool builtin:exec");
      expect(message).toContain("declared no tools");
      expect(message).toContain("code_mode_host = false");
    } finally {
      evaluateToolCalls.mockRestore();
    }
  });

  test("withdraws the calls the runtime admitted when the turn is refused for want of a notice tool", async () => {
    // The refusal withholds the whole response, so an admitted call from the
    // same batch never runs; the runtime must not keep it reserved. A control
    // call was never dispatched, and a denied call holds nothing.
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "toolless-batch",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: undefined,
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
    };
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async () => [
        { kind: "allow" as const },
        {
          kind: "deny" as const,
          feedback: "[appa] Refused: no plan.",
          offers: [],
        },
        { kind: "control" as const },
      ]);
    const cancelCalls = vi
      .spyOn(appaService, "cancelCalls")
      .mockResolvedValue(undefined);
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolCalls({
        ...context,
        toolCalls: [
          { id: "admitted", name: "read_file", arguments: '{"path":"a"}' },
          { id: "denied", name: "exec", arguments: { input: "..." } },
          { id: "control", name: "execute_remedy_plan", arguments: {} },
        ],
      });
      expect(outcome).toMatchObject({
        decision: "refuse",
        refusal: {
          reason: "openappa_no_notice_tool",
          blockedToolId: "denied",
          toolInput: { input: "..." },
        },
      });
      expect(cancelCalls).toHaveBeenCalledTimes(1);
      expect(cancelCalls.mock.calls[0][1]).toEqual(["admitted"]);
    } finally {
      cancelCalls.mockRestore();
      evaluateToolCalls.mockRestore();
    }
  });

  test("presents a denied run_tool dispatch as the target tool it named", async () => {
    // Static rules, annotator bindings, and the wildcard catch-all all evaluate
    // the dispatch's target, so the denial the model reads names that target —
    // its name and its own arguments — exactly as if the client had called it
    // directly. The wrapper is transport, not identity.
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "dispatch-session",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
    };
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async () => [
        {
          kind: "deny" as const,
          feedback:
            "[appa] Refused: grain__list_meetings needs the internal audience",
        },
      ]);
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolCalls({
        ...context,
        toolCalls: [
          {
            id: "dispatch-1",
            name: "archestra__run_tool",
            arguments: {
              tool_name: "grain__list_meetings",
              tool_args: { limit: 5 },
            },
          },
        ],
      });
      if (outcome?.decision !== "allow") throw new Error("expected a notice");
      expect(outcome.toolCalls).toHaveLength(1);
      const noticeCall = outcome.toolCalls[0];
      // Same position, same provider call id — only the identity changed hands.
      expect(noticeCall.name).toBe("archestra__get_remedy_plans");
      expect(noticeCall.id).toBe("dispatch-1");
      expect(JSON.parse(String(noticeCall.arguments))).toEqual({
        tool: "grain__list_meetings",
        arguments: JSON.stringify({ limit: 5 }),
        ruling:
          "[appa] Refused: grain__list_meetings needs the internal audience",
        notice: { v: 1, call_id: "dispatch-1", session: "dispatch-session" },
      });
      // `blocked` stays the wire batch's bookkeeping: the registry pins its
      // name to the call as given. The ruled-on identity lives in the notice.
      expect(outcome.blocked).toEqual([
        {
          id: "dispatch-1",
          name: "archestra__run_tool",
          reason:
            "[appa] Refused: grain__list_meetings needs the internal audience",
        },
      ]);
    } finally {
      evaluateToolCalls.mockRestore();
    }
  });

  test("presents a denied dispatch under a client alias the platform does not know as its target", async () => {
    // The alias a client registered the gateway under is free text; the loose
    // wrapper match still recovers the dispatch, and the notice names the
    // target the runtime ruled on.
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "aliased-dispatch",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
    };
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async () => [
        { kind: "deny" as const, feedback: "[appa] Refused: no plan." },
      ]);
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolCalls({
        ...context,
        toolCalls: [
          {
            id: "dispatch-2",
            name: "mcp__some_local_alias__archestra__run_tool",
            arguments: JSON.stringify({
              tool_name: "grain__fetch_meeting",
              tool_args: { meeting_id: "m-1" },
            }),
          },
        ],
      });
      if (outcome?.decision !== "allow") throw new Error("expected a notice");
      expect(JSON.parse(String(outcome.toolCalls[0].arguments))).toMatchObject({
        tool: "grain__fetch_meeting",
        arguments: JSON.stringify({ meeting_id: "m-1" }),
        notice: { call_id: "dispatch-2" },
      });
    } finally {
      evaluateToolCalls.mockRestore();
    }
  });

  test("expands a bare Archestra short name the way run_tool's own dispatch does", async () => {
    // run_tool accepts `read_file` and dispatches `archestra__read_file`; the
    // policy identity is the expansion, so a rule on the built-in name matches
    // either spelling of the call.
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "bare-target",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
    };
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async () => [
        { kind: "deny" as const, feedback: "[appa] Refused: no plan." },
      ]);
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolCalls({
        ...context,
        toolCalls: [
          {
            id: "dispatch-3",
            name: "archestra__run_tool",
            arguments: { tool_name: "list_agents", tool_args: {} },
          },
        ],
      });
      if (outcome?.decision !== "allow") throw new Error("expected a notice");
      expect(JSON.parse(String(outcome.toolCalls[0].arguments))).toMatchObject({
        tool: "archestra__list_agents",
        arguments: "{}",
      });
      expect(outcome.blocked?.[0]?.name).toBe("archestra__run_tool");
    } finally {
      evaluateToolCalls.mockRestore();
    }
  });

  test("a dispatch whose target cannot be recovered keeps the wrapper identity", async () => {
    // No usable tool_name means no target to name: the notice presents the
    // wrapper call as emitted. The gateway refuses such a call at execution.
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "opaque-dispatch",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
    };
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async () => [
        { kind: "deny" as const, feedback: "[appa] Refused: no plan." },
      ]);
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolCalls({
        ...context,
        toolCalls: [
          { id: "dispatch-4", name: "archestra__run_tool", arguments: {} },
        ],
      });
      if (outcome?.decision !== "allow") throw new Error("expected a notice");
      expect(JSON.parse(String(outcome.toolCalls[0].arguments))).toMatchObject({
        tool: "archestra__run_tool",
        notice: { call_id: "dispatch-4" },
      });
      expect(outcome.blocked?.[0]?.name).toBe("archestra__run_tool");
    } finally {
      evaluateToolCalls.mockRestore();
    }
  });

  test("refuses a denied dispatch with the target's identity when no notice tool can carry it", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "toolless-dispatch",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: undefined,
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
    };
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async () => [
        { kind: "deny" as const, feedback: "[appa] Refused: no plan." },
      ]);
    const cancelCalls = vi
      .spyOn(appaService, "cancelCalls")
      .mockResolvedValue(undefined);
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolCalls({
        ...context,
        toolCalls: [
          {
            id: "dispatch-5",
            name: "archestra__run_tool",
            arguments: {
              tool_name: "grain__list_meetings",
              tool_args: { limit: 5 },
            },
          },
        ],
      });
      expect(outcome).toMatchObject({
        decision: "refuse",
        refusal: {
          reason: "openappa_no_notice_tool",
          blockedToolName: "grain__list_meetings",
          blockedToolId: "dispatch-5",
          toolInput: { limit: 5 },
        },
      });
      // Nothing else in the batch was admitted, so nothing needs cancelling.
      expect(cancelCalls).toHaveBeenCalledTimes(1);
      expect(cancelCalls.mock.calls[0][1]).toEqual([]);
    } finally {
      cancelCalls.mockRestore();
      evaluateToolCalls.mockRestore();
    }
  });

  test("records the namespace a denied Codex call was declared in, so restoration can put it back", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "codex-session",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      spellings: new Map(),
      customTools: new Set(),
      // The declared map is the fallback; a call that names its own namespace
      // is recorded under that one, whatever the map says.
      namespaces: new Map([
        ["spawn_agent", "functions"],
        ["wait_agent", "multi_agent_v1"],
      ]),
    };
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async (_session, calls) =>
        calls.map(() => ({
          kind: "deny" as const,
          feedback: "[appa] Refused: no plan.",
          offers: [],
        })),
      );
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolCalls({
        ...context,
        toolCalls: [
          {
            id: "call-1",
            name: "spawn_agent",
            arguments: { message: "ls" },
            namespace: "multi_agent_v1",
          },
          { id: "call-2", name: "wait_agent", arguments: {} },
        ],
      });
      if (outcome?.decision !== "allow") throw new Error("expected a notice");
      expect(outcome.toolCalls.map((call) => call.name)).toEqual([
        "archestra__get_remedy_plans",
        "archestra__get_remedy_plans",
      ]);
      const notices = outcome.toolCalls.map((call) =>
        JSON.parse(String(call.arguments)),
      );
      expect(notices[0]).toMatchObject({
        tool: "spawn_agent",
        arguments: { message: "ls" },
        notice: { call_id: "call-1", namespace: "multi_agent_v1" },
      });
      expect(notices[1]).toMatchObject({
        tool: "wait_agent",
        notice: { call_id: "call-2", namespace: "multi_agent_v1" },
      });
    } finally {
      evaluateToolCalls.mockRestore();
    }
  });

  test("preserves both runtime and tool result text byte-for-byte", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "results-session",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "mcp__gw__archestra__execute_remedy_plan",
        noticeToolName: "mcp__gw__archestra__get_remedy_plans",
      },
      spellings: new Map([["github__list", "mcp__gw__github__list"]]),
      customTools: new Set(),
      namespaces: new Map(),
    };
    const processProxyResults = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {
          ruling: {
            content:
              '[appa] Blocked: call github__list again after execute_remedy_plan(offer_id: "x")',
            outputSource: "runtime",
          },
          listing: {
            content: "[appa] the repository names github__list in its README",
            outputSource: "tool",
          },
        },
        contextIsTrusted: true,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      } as never);
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolResults({
        ...context,
        toolResults: [
          { id: "ruling", name: "github__list", content: "" },
          { id: "listing", name: "github__list", content: "" },
        ],
      } as never);
      expect(outcome?.toolResultUpdates).toEqual({
        ruling:
          '[appa] Blocked: call github__list again after execute_remedy_plan(offer_id: "x")',
        listing: "[appa] the repository names github__list in its README",
      });
    } finally {
      processProxyResults.mockRestore();
    }
  });

  test("stamps only an origin-verified control call with its exact arguments", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "control-envelope",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
    };
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockResolvedValue([{ kind: "control" }]);
    try {
      await plugin.onSessionInit(context);
      const toolCalls = [
        {
          id: "provider-call-1",
          name: "archestra__execute_remedy_plan",
          arguments: '{ "offer_id": "offer-1", "plan": "narrow readers" }',
        },
      ];
      const outcome = await plugin.onPrepareToolCalls({
        ...context,
        toolCalls,
      });
      if (outcome?.decision !== "allow")
        throw new Error("expected transport annotation");
      const argumentsValue = JSON.parse(
        outcome.toolCalls[0].arguments as string,
      );
      expect(argumentsValue.execution).toEqual({
        v: 1,
        kind: "appa_remedy",
        call_id: "provider-call-1",
        tool_name: "archestra__execute_remedy_plan",
        original_arguments:
          '{ "offer_id": "offer-1", "plan": "narrow readers" }',
      });
      expect(toolCalls[0].arguments).toBe(
        '{ "offer_id": "offer-1", "plan": "narrow readers" }',
      );
      expect(evaluateToolCalls).not.toHaveBeenCalled();
    } finally {
      evaluateToolCalls.mockRestore();
    }
  });

  test("a fork's control call carries none of the offers its parent surfaced", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "user:user|fork",
      canonicalizeToolName: (name) => name,
    });
    const signed = (sessionId: string, offerId: string) =>
      signOfferClaims(
        unsignedOfferClaims({
          organizationId: "organization",
          sessionId,
          callerId: "user:user",
          offerId,
        }),
        "test-offer-signing-secret-32chars",
      );
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
      // The fork replays its parent's notices, offers included, beside its own.
      offerClaims: [
        signed("user:user|parent", "parent-offer"),
        signed("user:user|fork", "fork-offer"),
      ],
    };
    await plugin.onSessionInit(context);
    const outcome = await plugin.onPrepareToolCalls({
      ...context,
      toolCalls: ["parent-offer", "fork-offer"].map((offer_id, index) => ({
        id: `provider-call-${index}`,
        name: "archestra__execute_remedy_plan",
        arguments: JSON.stringify({ offer_id }),
      })),
    });
    if (outcome?.decision !== "allow") throw new Error("expected allow");
    const [parentOffer, forkOffer] = outcome.toolCalls.map((call) =>
      JSON.parse(call.arguments as string),
    );

    // Spending the parent's offer would change the parent's labels from
    // inside the fork: with no signed routing, the gateway knows no such offer.
    expect(parentOffer.signature).toBeUndefined();
    expect(forkOffer.signature).toEqual(expect.any(String));
  });

  test("gives a session's offer only to the control tool of the gateway's Codex namespace", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "user:user|codex",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
        controlNamespace: "mcp__my_gateway",
        noticeNamespace: "mcp__my_gateway",
      },
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
      offerClaims: [
        signOfferClaims(
          unsignedOfferClaims({
            organizationId: "organization",
            sessionId: "user:user|codex",
            callerId: "user:user",
            offerId: "offer-1",
          }),
          "test-offer-signing-secret-32chars",
        ),
      ],
    };
    await plugin.onSessionInit(context);
    const outcome = await plugin.onPrepareToolCalls({
      ...context,
      toolCalls: ["mcp__lookalike", "mcp__my_gateway"].map((namespace) => ({
        id: `call-${namespace}`,
        name: "archestra__execute_remedy_plan",
        namespace,
        arguments: JSON.stringify({ offer_id: "offer-1" }),
      })),
    });
    if (outcome?.decision !== "allow") throw new Error("expected allow");
    const [lookalike, gateway] = outcome.toolCalls.map((call) =>
      JSON.parse(call.arguments as string),
    );

    // Another server's member of the same name is a foreign tool: it gets
    // neither the signed offer nor the execution record.
    expect(lookalike).toEqual({ offer_id: "offer-1" });
    expect(gateway.signature).toEqual(expect.any(String));
    expect(gateway.execution).toMatchObject({
      kind: "appa_remedy",
      call_id: "call-mcp__my_gateway",
    });
  });

  test("strips a client-echoed JWS before stamping", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "control-envelope-stale-jws",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
    };
    await plugin.onSessionInit(context);
    const outcome = await plugin.onPrepareToolCalls({
      ...context,
      toolCalls: [
        {
          id: "provider-call-1",
          name: "archestra__execute_remedy_plan",
          arguments: JSON.stringify({
            offer_id: "offer-1",
            protected: "stale",
            payload: "stale",
            signature: "stale",
          }),
        },
      ],
    });
    if (outcome?.decision !== "allow") throw new Error("expected allow");
    const argumentsValue = JSON.parse(outcome.toolCalls[0].arguments as string);
    expect(argumentsValue.protected).toBeUndefined();
    expect(argumentsValue.payload).toBeUndefined();
    expect(argumentsValue.signature).toBeUndefined();
    expect(argumentsValue.execution.call_id).toBe("provider-call-1");
  });
});

function requestContext(params: {
  sessionId: string;
  canonicalizeToolName: (name: string) => string;
}): LlmProxyRequestContext {
  return {
    requestId: params.sessionId,
    organizationId: "organization",
    profileId: "profile",
    provider: "anthropic",
    interactionType: "anthropic:messages",
    model: "model",
    streaming: false,
    headers: {},
    requestBody: {},
    resources: new Map([
      [
        APPA_PLUGIN_TRUSTED_CONTEXT,
        {
          session: {
            organization_id: "organization",
            caller_id: "user:user",
            session_id: params.sessionId,
          },
          profileId: "profile",
          canonicalizeToolName: params.canonicalizeToolName,
          request: {
            tools: undefined,
            spellings: new Map(),
            customTools: new Set(),
            namespaces: new Map(),
          },
        },
      ],
    ]),
  };
}
