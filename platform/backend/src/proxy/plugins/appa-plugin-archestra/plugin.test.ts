import { vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import config from "@/config";
import { buildNoticeArguments } from "@/openappa/notice";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import { prepareAppaRequest } from "@/openappa/request";
import * as appaService from "@/openappa/service";
import type { LlmProxyRequestContext } from "@/proxy/plugins/registry";
import { beforeEach, describe, expect, test } from "@/test";
import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";
import { APPA_PLUGIN_TRUSTED_CONTEXT } from "./types";

vi.mock("@/cache-manager");

beforeEach(() => {
  config.openappa.offerSigningSecret = "test-openappa-signing-secret-123456";
});

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
      "Bash",
    );
    expect(codex.normalizeLocalToolName("functions.exec_command")).toBe(
      "exec_command",
    );
    expect(codex.normalizeLocalToolName("functions.builtin:read_file")).toBe(
      "read_file",
    );
    expect(openCode.normalizeLocalToolName("read_file")).toBe("read_file");
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
    // Each canonicalizer marks the local names it sees, so the output shows
    // which request's binding ruled the call.
    const first = requestContext({
      sessionId: "first-session",
      canonicalizeToolName: (name) =>
        name.startsWith("local:") ? `first:${name}` : name,
    });
    const second = requestContext({
      sessionId: "second-session",
      canonicalizeToolName: (name) =>
        name.startsWith("local:") ? `second:${name}` : name,
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

  test.each([
    {
      client: "Codex",
      // Codex declares the gateway's tools in its `mcp__<server>` namespace
      // under their bare names.
      adapter: new AppaCodexAdapter(),
      headers: { originator: "codex_cli_rs" },
      gatewayCall: "archestra__ask_user",
      namespaces: new Map([["archestra__ask_user", "mcp__my_gateway"]]),
      localCall: "exec_command",
    },
    {
      client: "OpenCode",
      // OpenCode decorates the gateway's tools as `<label>_<tool>`.
      adapter: new AppaOpenCodeAdapter(),
      headers: { "x-opencode-session": "s" },
      gatewayCall: "my_gateway_archestra__ask_user",
      namespaces: new Map<string, string>(),
      localCall: "exec_command",
    },
  ])("rules $client's call to a gateway tool as the gateway's tool, not a builtin", async ({
    adapter,
    headers,
    gatewayCall,
    namespaces,
    localCall,
  }) => {
    // Ruled as a client builtin, a gateway tool would miss both the policy's
    // rule for it and the ask_user exemption.
    const ruledAs: string[] = [];
    const evaluateToolCalls = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async (_session, calls, options) => {
        ruledAs.push(...calls.map((call) => options.canonicalize(call.name)));
        return calls.map(() => ({ kind: "allow" }) as const);
      });
    const plugin = new AppaPluginArchestra([adapter]);
    const context = requestContext({
      sessionId: "client-naming-session",
      canonicalizeToolName: (name) =>
        name.replace(/^my_gateway_(?=archestra__)/, ""),
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      ...(trusted.request as Record<string, unknown>),
      namespaces,
    };
    context.headers = headers;

    try {
      await plugin.onSessionInit(context);
      await plugin.onToolCalls({
        ...context,
        toolCalls: [
          { id: "ask", name: gatewayCall, arguments: {} },
          { id: "shell", name: localCall, arguments: {} },
        ],
      });

      expect(ruledAs).toEqual(["archestra__ask_user", localCall]);
    } finally {
      evaluateToolCalls.mockRestore();
    }
  });
});

describe("asking through the client's own question tool", () => {
  test.each([
    { declared: true, expected: "question" },
    // `opencode run` declares no question tool: nothing could render it.
    { declared: false, expected: "my_gateway_archestra__ask_user" },
  ])("hands OpenCode the model's ask_user as its question tool (declared=$declared)", async ({
    declared,
    expected,
  }) => {
    const plugin = new AppaPluginArchestra([new AppaOpenCodeAdapter()]);
    const context = requestContext({
      sessionId: "opencode-question-session",
      canonicalizeToolName: (name) =>
        name.replace(/^my_gateway_(?=archestra__)/, ""),
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      ...(trusted.request as Record<string, unknown>),
      tools: {
        controlToolName: "my_gateway_archestra__execute_remedy_plan",
        noticeToolName: "my_gateway_archestra__get_remedy_plans",
      },
      spellings: new Map(declared ? [["question", "question"]] : []),
    };
    context.headers = { "x-opencode-session": "s" };
    const askUser = {
      question: "Accept this change for the rest of this session?",
      options: [
        { label: "Accept", description: "Narrow who can read it" },
        { label: "Do not accept" },
      ],
    };

    try {
      await plugin.onSessionInit(context);
      const toolCalls = [
        {
          id: "call_ask",
          name: "my_gateway_archestra__ask_user",
          arguments: JSON.stringify(askUser),
        },
      ];
      const outcome = await plugin.onPrepareToolCalls({
        ...context,
        toolCalls,
      });

      // No outcome means the calls go out as the model made them.
      const released =
        outcome?.decision === "allow" ? outcome.toolCalls : toolCalls;
      expect(released).toHaveLength(1);
      expect(released[0].id).toMatch(
        declared
          ? /^call_aq1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{22}$/
          : /^call_ask$/,
      );
      expect(released[0].name).toBe(expected);
      if (declared) {
        expect(JSON.parse(released[0].arguments as string)).toEqual({
          questions: [
            {
              question: askUser.question,
              header: "Question",
              options: [
                { label: "Accept", description: "Narrow who can read it" },
                { label: "Do not accept", description: "Do not accept" },
              ],
              multiple: false,
            },
          ],
        });
      }
    } finally {
      await plugin.onCleanup(context);
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
      platformToolNames: new Set(["archestra__ask_user"]),
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
        notice: { v: 1, call_id: "dispatch-1" },
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
      platformToolNames: new Set(["archestra__ask_user"]),
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

  test.each([
    {
      adapter: new AppaOpenCodeAdapter(),
      name: "question",
      content:
        'User has answered your questions: "Accept the change?"="Do not accept the change". You can now continue with the user\'s answers in mind.',
      isError: false,
    },
    {
      adapter: new AppaOpenCodeAdapter(),
      name: "question",
      content: "Error: The user dismissed this question",
      isError: true,
    },
    {
      adapter: new AppaOpenCodeAdapter(),
      name: "question",
      content:
        'User has answered your questions: "Color?"="Blue", "Fruit?"="Pear".',
      isError: false,
    },
    {
      adapter: new AppaClaudeCodeAdapter(),
      name: "AskUserQuestion",
      content: '{"answers":{"Accept the change?":"Do not accept"}}',
      isError: false,
    },
    {
      adapter: new AppaCodexAdapter(),
      name: "functions.request_user_input",
      content: '{"answers":{"remedy":{"answers":["Do not accept"]}}}',
      isError: false,
    },
  ])("preserves $adapter.id native answers and carries decline guidance ($isError)", async ({
    adapter,
    name,
    content,
    isError,
  }) => {
    const plugin = new AppaPluginArchestra([adapter]);
    const context = requestContext({
      sessionId: "native-answer",
      canonicalizeToolName: (name) => name,
    });
    context.headers = { "user-agent": adapter.id };
    context.interactionType = "openai:chatCompletions";
    const processResults = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: false,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    try {
      await plugin.onSessionInit(context);
      const issuedId = await issueNativeQuestion({ plugin, context, name });
      const result = { id: issuedId, name, content, isError };
      const outcome = await plugin.onToolResults({
        ...context,
        toolResults: [result],
      });
      expect(outcome?.toolResultUpdates).toEqual({});
      expect(processResults.mock.calls[0][0].isUserQuestion?.(result)).toBe(
        true,
      );
      expect(outcome?.contextTrust?.contextIsTrusted).toBe(false);
      expect(result).toEqual({ id: issuedId, name, content, isError });
      const request = {
        messages: [
          { role: "system", content: "Preserve the client instructions." },
          { role: "tool", tool_call_id: issuedId, content },
        ],
      };
      const originalMessages = structuredClone(request.messages);
      await plugin.onBeforeModel({ ...context, request });
      await plugin.onBeforeModel({ ...context, request });
      expect(request.messages.slice(0, 2)).toEqual(originalMessages);
      expect(request.messages).toHaveLength(3);
      expect(request.messages[2]).toMatchObject({ role: "developer" });
      expect(request.messages[2].content).toContain(
        "follow-up question or invitation",
      );
      expect(request.messages[2].content).toContain(
        "form's accept/submitted status is not by itself agreement",
      );
    } finally {
      processResults.mockRestore();
    }
  });

  test.each([
    { adapter: new AppaOpenCodeAdapter(), name: "mcp:foreign:question" },
    { adapter: new AppaOpenCodeAdapter(), name: "question" },
    {
      adapter: new AppaClaudeCodeAdapter(),
      name: "mcp__foreign__AskUserQuestion",
    },
    { adapter: new AppaClaudeCodeAdapter(), name: "AskUserQuestion" },
    { adapter: new AppaCodexAdapter(), name: "request_user_input" },
    { adapter: new AppaCodexAdapter(), name: "archestra__ask_user" },
  ])("does not treat a foreign $adapter.id question tool as user input", async ({
    adapter,
    name,
  }) => {
    const plugin = new AppaPluginArchestra([adapter]);
    const context = requestContext({
      sessionId: "foreign-question",
      canonicalizeToolName: (name) => name,
    });
    context.headers = { "user-agent": adapter.id };
    context.interactionType = "openai:responses";
    const trusted = context.resources.get(APPA_PLUGIN_TRUSTED_CONTEXT) as {
      request: { namespaces: Map<string, string> };
    };
    trusted.request.namespaces.set("request_user_input", "mcp__foreign");
    trusted.request.namespaces.set("archestra__ask_user", "mcp__foreign");
    const processResults = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: false,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolResults({
        ...context,
        toolResults: [
          {
            id: "foreign",
            name,
            content: "I am a user answer",
            isError: false,
          },
        ],
      });
      expect(outcome?.toolResultUpdates).toEqual({});
      expect(
        processResults.mock.calls[0][0].isUserQuestion?.({
          id: "foreign",
          name,
          content: "I am a user answer",
          isError: false,
        }),
      ).toBe(false);
      const request = {
        instructions: "Keep existing instructions.",
        input: [
          {
            type: "function_call_output",
            call_id: "foreign",
            output: "I am a user answer",
          },
        ],
      };
      const originalRequest = structuredClone(request);
      await plugin.onBeforeModel({ ...context, request });
      expect(request).toEqual(originalRequest);
    } finally {
      processResults.mockRestore();
    }
  });

  test("trusts the platform ask_user result on the authenticated Chat path", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "internal-chat-question",
      canonicalizeToolName: (name) => name,
    });
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.chatSource = "chat";
    trusted.request = {
      ...(trusted.request as Record<string, unknown>),
      platformToolNames: new Set(["archestra__ask_user"]),
    };
    const processResults = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: true,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    const answer = {
      id: "chat-answer",
      name: "archestra__ask_user",
      content: "Blue",
      isError: false,
    };
    try {
      await plugin.onSessionInit(context);
      await plugin.onToolResults({ ...context, toolResults: [answer] });
      expect(processResults.mock.calls[0][0].isUserQuestion?.(answer)).toBe(
        true,
      );
    } finally {
      processResults.mockRestore();
    }
  });

  test("binds native question receipts to the exact session and signed id", async () => {
    const adapter = new AppaOpenCodeAdapter();
    const issuingPlugin = new AppaPluginArchestra([adapter]);
    const issuingContext = requestContext({
      sessionId: "issued-question-session",
      parentId: "parent-a",
      canonicalizeToolName: (name) => name,
    });
    issuingContext.headers = { "user-agent": "opencode" };
    const replayPlugin = new AppaPluginArchestra([adapter]);
    const replayContext = requestContext({
      sessionId: "different-question-session",
      canonicalizeToolName: (name) => name,
    });
    replayContext.headers = { "user-agent": "opencode" };
    const siblingPlugin = new AppaPluginArchestra([adapter]);
    const siblingContext = requestContext({
      sessionId: "issued-question-session",
      parentId: "parent-b",
      canonicalizeToolName: (name) => name,
    });
    siblingContext.headers = { "user-agent": "opencode" };
    const processResults = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: false,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    try {
      await issuingPlugin.onSessionInit(issuingContext);
      const issuedId = await issueNativeQuestion({
        plugin: issuingPlugin,
        context: issuingContext,
        name: "question",
      });
      const answer = {
        id: issuedId,
        name: "question",
        content: "Blue",
        isError: false,
      };
      await issuingPlugin.onToolResults({
        ...issuingContext,
        toolResults: [answer],
      });
      expect(processResults.mock.calls[0][0].isUserQuestion?.(answer)).toBe(
        true,
      );
      await issuingPlugin.onPrepareToolCalls({
        ...issuingContext,
        toolCalls: [
          {
            id: issuedId,
            name: "question",
            arguments: "{}",
          },
        ],
      });
      await issuingPlugin.onToolResults({
        ...issuingContext,
        toolResults: [answer],
      });
      expect(processResults.mock.calls[1][0].isUserQuestion?.(answer)).toBe(
        false,
      );

      const crossSessionId = await issueNativeQuestion({
        plugin: issuingPlugin,
        context: issuingContext,
        name: "question",
      });
      const alteredId = `${issuedId.slice(0, -1)}${issuedId.endsWith("a") ? "b" : "a"}`;
      await issuingPlugin.onToolResults({
        ...issuingContext,
        toolResults: [
          { id: alteredId, name: "question", content: "Blue", isError: false },
        ],
      });
      expect(
        processResults.mock.calls[2][0].isUserQuestion?.({
          id: alteredId,
          name: "question",
          content: "Blue",
          isError: false,
        }),
      ).toBe(false);

      await replayPlugin.onSessionInit(replayContext);
      await replayPlugin.onToolResults({
        ...replayContext,
        toolResults: [
          {
            id: crossSessionId,
            name: "question",
            content: "Blue",
            isError: false,
          },
        ],
      });
      expect(
        processResults.mock.calls[3][0].isUserQuestion?.({
          id: crossSessionId,
          name: "question",
          content: "Blue",
          isError: false,
        }),
      ).toBe(false);

      await siblingPlugin.onSessionInit(siblingContext);
      await siblingPlugin.onToolResults({
        ...siblingContext,
        toolResults: [
          {
            id: crossSessionId,
            name: "question",
            content: "Blue",
            isError: false,
          },
        ],
      });
      expect(
        processResults.mock.calls[4][0].isUserQuestion?.({
          id: crossSessionId,
          name: "question",
          content: "Blue",
          isError: false,
        }),
      ).toBe(false);
    } finally {
      processResults.mockRestore();
    }
  });

  test("refuses to issue a native question without a signing key", async () => {
    config.openappa.offerSigningSecret = "";
    const plugin = new AppaPluginArchestra([new AppaOpenCodeAdapter()]);
    const context = requestContext({
      sessionId: "unsigned-question-session",
      canonicalizeToolName: (name) => name,
    });
    context.headers = { "user-agent": "opencode" };
    await plugin.onSessionInit(context);

    await expect(
      issueNativeQuestion({ plugin, context, name: "question" }),
    ).rejects.toThrow("native question signing is not configured");
  });

  test("rejects duplicate native-question receipt IDs before result governance", async () => {
    const plugin = new AppaPluginArchestra([new AppaOpenCodeAdapter()]);
    const context = requestContext({
      sessionId: "duplicate-answer-session",
      canonicalizeToolName: (name) => name,
    });
    context.headers = { "user-agent": "opencode" };
    const processResults = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: false,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    try {
      await plugin.onSessionInit(context);
      const issuedId = await issueNativeQuestion({
        plugin,
        context,
        name: "question",
      });
      const first = {
        id: issuedId,
        name: "question",
        content: "Blue",
        isError: false,
      };
      const duplicate = { ...first, content: "Red" };
      await expect(
        plugin.onToolResults({
          ...context,
          toolResults: [first, duplicate],
        }),
      ).rejects.toThrow("Duplicate native question result IDs are not allowed");
      expect(processResults).not.toHaveBeenCalled();
    } finally {
      processResults.mockRestore();
    }
  });

  test("does not partially consume receipts when a batch claim fails", async () => {
    const plugin = new AppaPluginArchestra([new AppaOpenCodeAdapter()]);
    const context = requestContext({
      sessionId: "atomic-batch-session",
      canonicalizeToolName: (name) => name,
    });
    context.headers = { "user-agent": "opencode" };
    const processResults = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: false,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    try {
      await plugin.onSessionInit(context);
      const first = {
        id: await issueNativeQuestion({ plugin, context, name: "question" }),
        name: "question",
        content: "Blue",
        isError: false,
      };
      const second = {
        id: await issueNativeQuestion({ plugin, context, name: "question" }),
        name: "question",
        content: "Red",
        isError: false,
      };
      const batchClaim = vi
        .spyOn(cacheManager, "getAndDeleteMany")
        .mockRejectedValueOnce(new Error("Shared cache unavailable"));

      await expect(
        plugin.onToolResults({
          ...context,
          toolResults: [first, second],
        }),
      ).rejects.toThrow("Shared cache unavailable");
      batchClaim.mockRestore();
      await plugin.onToolResults({
        ...context,
        toolResults: [first, second],
      });
      const isUserQuestion = processResults.mock.calls[0][0].isUserQuestion;
      expect(isUserQuestion?.(first)).toBe(true);
      expect(isUserQuestion?.(second)).toBe(true);
    } finally {
      processResults.mockRestore();
    }
  });

  test("does not replace policy output with a native question's raw result", async () => {
    const plugin = new AppaPluginArchestra([new AppaOpenCodeAdapter()]);
    const context = requestContext({
      sessionId: "question-policy",
      canonicalizeToolName: (name) => name,
    });
    context.headers = { "user-agent": "opencode" };
    const processResults = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {
          answer: { content: "[appa] Blocked", outputSource: "runtime" },
        },
        contextIsTrusted: false,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    try {
      await plugin.onSessionInit(context);
      const outcome = await plugin.onToolResults({
        ...context,
        toolResults: [
          {
            id: "answer",
            name: "question",
            content: "Accept it",
            isError: false,
          },
        ],
      });
      expect(outcome?.toolResultUpdates).toEqual({ answer: "[appa] Blocked" });
      const request = { system: "Preserve policy output." };
      await plugin.onBeforeModel({ ...context, request });
      expect(request.system).toBe("Preserve policy output.");
    } finally {
      processResults.mockRestore();
    }
  });

  test.each([
    "Keep the client's system instructions.",
    [
      {
        type: "text",
        text: "Keep the cached system block.",
        cache_control: { type: "ephemeral" },
      },
    ],
    undefined,
  ])("preserves Anthropic system instructions when adding question guidance (%j)", async (system) => {
    const plugin = new AppaPluginArchestra([new AppaClaudeCodeAdapter()]);
    const context = requestContext({
      sessionId: "claude-answer",
      canonicalizeToolName: (name) => name,
    });
    context.headers = { "user-agent": "claude-code" };
    const processResults = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: true,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    try {
      await plugin.onSessionInit(context);
      const issuedId = await issueNativeQuestion({
        plugin,
        context,
        name: "AskUserQuestion",
      });
      await plugin.onToolResults({
        ...context,
        toolResults: [
          {
            id: issuedId,
            name: "AskUserQuestion",
            content: "Do not accept",
            isError: false,
          },
        ],
      });
      const request = {
        system: structuredClone(system),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: issuedId,
                content: "Do not accept",
              },
            ],
          },
        ],
      };
      const original = structuredClone(request);
      await plugin.onBeforeModel({ ...context, request });
      const firstPass = structuredClone(request);
      await plugin.onBeforeModel({ ...context, request });
      expect(request).toEqual(firstPass);
      expect(request.messages).toEqual(original.messages);
      if (Array.isArray(system)) {
        expect(request.system).toHaveLength(system.length + 1);
        expect((request.system as unknown[]).slice(0, system.length)).toEqual(
          system,
        );
      } else if (system) {
        expect(request.system).toEqual(
          expect.stringContaining(`${system}\n\n`),
        );
      }
      expect(JSON.stringify(request.system)).toContain(
        "follow-up question or invitation",
      );
    } finally {
      processResults.mockRestore();
    }
  });

  test("adds trusted Codex continuation after a native question result", async () => {
    const plugin = new AppaPluginArchestra([new AppaCodexAdapter()]);
    const context = requestContext({
      sessionId: "codex-remedy-continuation",
      canonicalizeToolName: (name) => name,
    });
    context.headers = { originator: "codex_cli_rs" };
    context.interactionType = "openai:responses";
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      spellings: new Map([["request_user_input", "request_user_input"]]),
      customTools: new Set(),
      namespaces: new Map(),
    };
    const processResults = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: true,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    try {
      await plugin.onSessionInit(context);
      const issuedId = await issueNativeQuestion({
        plugin,
        context,
        name: "request_user_input",
      });
      await plugin.onToolResults({
        ...context,
        toolResults: [
          {
            id: issuedId,
            name: "request_user_input",
            content: "The user accepted the offered remedy.",
            isError: false,
          },
        ],
      });
      const request = {
        instructions: "Keep existing Codex instructions.",
        input: [
          {
            type: "function_call_output",
            call_id: issuedId,
            output: "The user accepted the offered remedy.",
          },
        ],
        tool_choice: "auto",
        reasoning: { summary: "detailed" },
      };
      await plugin.onBeforeModel({ ...context, request });

      expect(request.instructions).toBe("Keep existing Codex instructions.");
      expect(request.input[0]).toEqual({
        type: "function_call_output",
        call_id: issuedId,
        output: "The user accepted the offered remedy.",
      });
      expect(request.input[1]).toMatchObject({ role: "developer" });
      expect(JSON.stringify(request.input[1])).toContain(
        "form's accept/submitted status is not by itself agreement",
      );
      expect(JSON.stringify(request.input[1])).toContain(
        "do not require a second free-text answer",
      );
      expect(JSON.stringify(request.input[1])).toContain(
        "only after the remedy reports successful authorization",
      );
      expect(JSON.stringify(request.input[1])).toContain(
        "do not apply new offers or repeat the workflow under the earlier acceptance",
      );
      expect(JSON.stringify(request.input[1])).toContain(
        "without repeating options, asking again",
      );
      await plugin.onBeforeModel({ ...context, request });
      expect(request.input).toHaveLength(2);
      expect(request.tool_choice).toBe("auto");
      expect(request.reasoning).toEqual({ summary: "detailed" });
    } finally {
      processResults.mockRestore();
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

  test("attaches this turn's offers to ask_user calls and strips client-echoed ones", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "ask-user-offers",
      canonicalizeToolName: (name) => name,
    });
    const envelope = signOfferClaims(
      unsignedOfferClaims({
        organizationId: "organization",
        sessionId: "ask-user-offers",
        offerId: "offer-1",
      }),
      config.openappa.offerSigningSecret,
    );
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      platformToolNames: new Set(["archestra__ask_user"]),
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
      offerClaims: [envelope],
      askUserOfferClaims: [envelope],
    };
    await plugin.onSessionInit(context);
    const outcome = await plugin.onPrepareToolCalls({
      ...context,
      toolCalls: [
        {
          id: "provider-call-1",
          name: "archestra__ask_user",
          arguments: JSON.stringify({
            question: "Accept?",
            options: [{ label: "Yes" }, { label: "No" }],
            remedy_offer_ids: ["offer-1"],
            remedy_offers: [{ protected: "x", payload: "x", signature: "x" }],
          }),
        },
      ],
    });
    if (outcome?.decision !== "allow") throw new Error("expected allow");
    const argumentsValue = JSON.parse(outcome.toolCalls[0].arguments as string);
    expect(argumentsValue.remedy_offers).toEqual([envelope]);
  });

  test("binds each parallel question to its requested offer exactly once", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "parallel-question-offers",
      canonicalizeToolName: (name) => name,
    });
    const envelopes = ["offer-1", "offer-2"].map((offerId) =>
      signOfferClaims(
        unsignedOfferClaims({
          organizationId: "organization",
          sessionId: "parallel-question-offers",
          offerId,
        }),
        config.openappa.offerSigningSecret,
      ),
    );
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      platformToolNames: new Set(["archestra__ask_user"]),
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
      askUserOfferClaims: envelopes,
    };
    await plugin.onSessionInit(context);
    const question = (id: string, offerId: string) => ({
      id,
      name: "archestra__ask_user",
      arguments: JSON.stringify({
        question: `Accept ${offerId}?`,
        options: [{ label: "Yes" }, { label: "No" }],
        remedy_offer_ids: [offerId],
      }),
    });
    const outcome = await plugin.onPrepareToolCalls({
      ...context,
      toolCalls: [
        question("question-1", "offer-1"),
        question("question-2", "offer-2"),
        question("question-reuse", "offer-1"),
      ],
    });
    if (outcome?.decision !== "allow") throw new Error("expected allow");
    const argumentsById = new Map(
      outcome.toolCalls.map((call) => [
        call.id,
        JSON.parse(call.arguments as string),
      ]),
    );
    expect(argumentsById.get("question-1")?.remedy_offers).toEqual([
      envelopes[0],
    ]);
    expect(argumentsById.get("question-2")?.remedy_offers).toEqual([
      envelopes[1],
    ]);
    expect(argumentsById.get("question-reuse")?.remedy_offers).toBeUndefined();
  });

  test("drops model-written offers from ask_user when this turn issued none", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "ask-user-no-live-offers",
      canonicalizeToolName: (name) => name,
    });
    // Signed for this very session, as a copy lifted from its own history
    // would be — still not the proxy's to carry once its turn is over.
    const replayed = signOfferClaims(
      unsignedOfferClaims({
        organizationId: "organization",
        sessionId: "ask-user-no-live-offers",
        offerId: "offer-spent",
      }),
      config.openappa.offerSigningSecret,
    );
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: {
        controlToolName: "archestra__execute_remedy_plan",
        noticeToolName: "archestra__get_remedy_plans",
      },
      platformToolNames: new Set(["archestra__ask_user"]),
      spellings: new Map(),
      customTools: new Set(),
      namespaces: new Map(),
      offerClaims: [],
    };
    await plugin.onSessionInit(context);
    const question = {
      question: "Accept?",
      options: [{ label: "Yes" }, { label: "No" }],
    };
    const outcome = await plugin.onPrepareToolCalls({
      ...context,
      toolCalls: [
        {
          id: "provider-call-1",
          name: "archestra__ask_user",
          arguments: JSON.stringify({ ...question, remedy_offers: [replayed] }),
        },
        {
          id: "provider-call-2",
          name: "archestra__ask_user",
          arguments: JSON.stringify(question),
        },
      ],
    });
    if (outcome?.decision !== "allow") throw new Error("expected allow");
    expect(JSON.parse(outcome.toolCalls[0].arguments as string)).toEqual(
      question,
    );
    // A call with nothing to drop reaches the client byte for byte.
    expect(outcome.toolCalls[1].arguments).toBe(JSON.stringify(question));
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

describe("keeping the proxy's transport data away from the model", () => {
  const ASK_USER = "archestra__ask_user";
  const CONTROL = "archestra__execute_remedy_plan";
  const NOTICE = "archestra__get_remedy_plans";
  // What the gateway lists: each tool's own arguments, plus the ones only the
  // proxy may write.
  const DECLARED = [
    {
      name: ASK_USER,
      schema: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array" },
          remedy_offer_ids: { type: "array" },
          remedy_offers: { type: "array" },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
    {
      name: CONTROL,
      schema: {
        type: "object",
        properties: {
          offer_id: { type: "string" },
          plan: { type: "string" },
          execution: { type: "object" },
          protected: { type: "string" },
          payload: { type: "string" },
          signature: { type: "string" },
        },
        required: ["offer_id", "plan"],
      },
    },
    { name: NOTICE, schema: { type: "object", properties: {} } },
  ];
  const askUserArguments = {
    question: "Narrow who can read the report, then share it?",
    options: [{ label: "Narrow and share" }, { label: "Do not share" }],
    remedy_offer_ids: ["offer-1"],
  };
  const controlArguments = '{"offer_id":"offer-1","plan":"narrow readers"}';
  const staleControlArguments =
    '{"offer_id":"offer-1","plan":"narrow readers","protected":"stale","payload":"stale","signature":"stale"}';

  test.each([
    "anthropic:messages",
    "openai:chatCompletions",
    "openai:responses",
  ] as const)("stamps the client's calls and hands the provider the model's own back (%s)", async (wire) => {
    const plugin = new AppaPluginArchestra([]);
    const context = requestContext({
      sessionId: "transport-round-trip",
      canonicalizeToolName: (name) => name,
    });
    const envelope = signOfferClaims(
      unsignedOfferClaims({
        organizationId: "organization",
        sessionId: "transport-round-trip",
        offerId: "offer-1",
      }),
      config.openappa.offerSigningSecret,
    );
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    trusted.request = {
      tools: { controlToolName: CONTROL, noticeToolName: NOTICE },
      spellings: new Map(),
      platformToolNames: new Set([ASK_USER]),
      customTools: new Set(),
      namespaces: new Map(),
      offerClaims: [envelope],
      askUserOfferClaims: [envelope],
    };
    await plugin.onSessionInit(context);
    const outcome = await plugin.onPrepareToolCalls({
      ...context,
      toolCalls: [
        {
          id: "call_ask",
          name: ASK_USER,
          arguments: JSON.stringify(askUserArguments),
        },
        {
          id: "call_control",
          name: CONTROL,
          arguments: staleControlArguments,
        },
      ],
    });
    await plugin.onCleanup(context);
    if (outcome?.decision !== "allow") throw new Error("expected stamping");

    // The client gets both calls stamped, as the tools need them.
    const [askUser, control] = outcome.toolCalls.map((call) => ({
      ...call,
      arguments: call.arguments as string,
    }));
    expect(JSON.parse(askUser.arguments)).toEqual({
      ...askUserArguments,
      remedy_offers: [envelope],
    });
    expect(JSON.parse(control.arguments)).toMatchObject({
      offer_id: "offer-1",
      execution: { original_arguments: controlArguments },
      ...envelope,
    });

    // The client echoes the stamped calls in its next request.
    const body = history(wire, [askUser, control]);
    prepareAppaRequest({
      body,
      interactionType: wire,
      canonicalizeToolName: (name) => name,
      trustBarePlatformTools: true,
    });

    const sent = sentCalls(wire, body);
    expect(sent.get("call_ask")).toEqual(askUserArguments);
    expect(sent.get("call_control")).toEqual(
      wire === "anthropic:messages"
        ? JSON.parse(controlArguments)
        : controlArguments,
    );
    expect(sentParameters(wire, body)).toEqual(
      new Map([
        [
          ASK_USER,
          {
            names: ["question", "options", "remedy_offer_ids"],
            required: ["question", "options"],
          },
        ],
        [
          CONTROL,
          { names: ["offer_id", "plan"], required: ["offer_id", "plan"] },
        ],
      ]),
    );
  });

  test.each([
    "anthropic:messages",
    "openai:chatCompletions",
    "openai:responses",
  ] as const)("stamps ask_user with the offers of this turn's block only (%s)", async (wire) => {
    const envelope = signOfferClaims(
      unsignedOfferClaims({
        organizationId: "organization",
        sessionId: "transport-turns",
        offerId: "offer-1",
      }),
      config.openappa.offerSigningSecret,
    );
    const notice = {
      id: "call_blocked",
      name: NOTICE,
      arguments: JSON.stringify(
        buildNoticeArguments({
          id: "call_blocked",
          tool: "archestra__list_skills",
          arguments: {},
          result: "[appa] Blocked: this call cannot run yet.",
          offers: [envelope],
        }),
      ),
    };
    const askUserCall = {
      id: "call_ask",
      name: ASK_USER,
      arguments: JSON.stringify(askUserArguments),
    };
    const stampedOffers = async (body: Record<string, unknown>) => {
      const plugin = new AppaPluginArchestra([]);
      const context = requestContext({
        sessionId: "transport-turns",
        canonicalizeToolName: (name) => name,
      });
      const trusted = context.resources.get(
        APPA_PLUGIN_TRUSTED_CONTEXT,
      ) as Record<string, unknown>;
      trusted.request = prepareAppaRequest({
        body,
        interactionType: wire,
        canonicalizeToolName: (name) => name,
        trustBarePlatformTools: true,
      });
      await plugin.onSessionInit(context);
      const outcome = await plugin.onPrepareToolCalls({
        ...context,
        toolCalls: [askUserCall],
      });
      await plugin.onCleanup(context);
      const [call] = outcome?.decision === "allow" ? outcome.toolCalls : [];
      return call
        ? JSON.parse(call.arguments as string).remedy_offers
        : undefined;
    };

    // The model asks right after the block, in the same turn.
    expect(await stampedOffers(history(wire, [notice]))).toEqual([envelope]);

    // The user wrote since: the block's offer went with its turn, and a new
    // question is about something else.
    const nextTurn = history(wire, [notice]);
    const followUp = { role: "user", content: "Export it as PDF or CSV?" };
    if (wire === "openai:responses")
      (nextTurn.input as unknown[]).push({ ...followUp, type: "message" });
    else (nextTurn.messages as unknown[]).push(followUp);
    expect(await stampedOffers(nextTurn)).toBeUndefined();

    if (wire === "anthropic:messages") {
      const mixedTurn = history(wire, [notice]);
      const resultTurn = (
        mixedTurn.messages as {
          content: Record<string, unknown>[];
        }[]
      ).at(-1);
      resultTurn?.content.push({
        type: "text",
        text: "What should I do next?",
      });
      expect(await stampedOffers(mixedTurn)).toBeUndefined();
    }
  });

  /** A request whose history holds the calls exactly as the client got them. */
  function history(
    wire: "anthropic:messages" | "openai:chatCompletions" | "openai:responses",
    calls: { id: string; name: string; arguments: string }[],
  ): Record<string, unknown> {
    const prompt = { role: "user", content: "Share the quarterly report" };
    if (wire === "anthropic:messages") {
      return {
        tools: DECLARED.map(({ name, schema }) => ({
          name,
          input_schema: structuredClone(schema),
        })),
        messages: [
          prompt,
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "ask first", signature: "sig" },
              ...calls.map((call) => ({
                type: "tool_use",
                id: call.id,
                name: call.name,
                input: JSON.parse(call.arguments),
              })),
            ],
          },
          {
            role: "user",
            content: calls.map((call) => ({
              type: "tool_result",
              tool_use_id: call.id,
              content: "done",
            })),
          },
        ],
      };
    }
    if (wire === "openai:chatCompletions") {
      return {
        tools: DECLARED.map(({ name, schema }) => ({
          type: "function",
          function: { name, parameters: structuredClone(schema) },
        })),
        messages: [
          prompt,
          {
            role: "assistant",
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          ...calls.map((call) => ({
            role: "tool",
            tool_call_id: call.id,
            content: "done",
          })),
        ],
      };
    }
    return {
      tools: DECLARED.map(({ name, schema }) => ({
        type: "function",
        name,
        parameters: structuredClone(schema),
      })),
      input: [
        { ...prompt, type: "message" },
        ...calls.flatMap((call) => [
          {
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          },
          { type: "function_call_output", call_id: call.id, output: "done" },
        ]),
      ],
    };
  }

  /** Each call's arguments as the provider receives them, by call id. */
  function sentCalls(
    wire: "anthropic:messages" | "openai:chatCompletions" | "openai:responses",
    body: Record<string, unknown>,
  ): Map<string, unknown> {
    if (wire === "anthropic:messages") {
      const messages = body.messages as { content: unknown }[];
      const blocks = messages[1].content as Record<string, unknown>[];
      expect(blocks[0]).toEqual({
        type: "thinking",
        thinking: "ask first",
        signature: "sig",
      });
      return new Map(
        blocks
          .filter((block) => block.type === "tool_use")
          .map((block) => [block.id as string, block.input]),
      );
    }
    if (wire === "openai:chatCompletions") {
      const messages = body.messages as {
        tool_calls?: { id: string; function: { arguments: string } }[];
      }[];
      return new Map(
        (messages[1].tool_calls ?? []).map((call) => [
          call.id,
          call.id === "call_ask"
            ? JSON.parse(call.function.arguments)
            : call.function.arguments,
        ]),
      );
    }
    const input = body.input as Record<string, unknown>[];
    return new Map(
      input
        .filter((item) => item.type === "function_call")
        .map((item) => [
          item.call_id as string,
          item.call_id === "call_ask"
            ? JSON.parse(item.arguments as string)
            : item.arguments,
        ]),
    );
  }

  /** The parameters each declared tool offers the model, by tool name. */
  function sentParameters(
    wire: "anthropic:messages" | "openai:chatCompletions" | "openai:responses",
    body: Record<string, unknown>,
  ): Map<string, { names: string[]; required: unknown }> {
    const tools = body.tools as Record<string, unknown>[];
    return new Map(
      tools.map((tool) => {
        const fn = tool.function as Record<string, unknown> | undefined;
        const schema = (
          wire === "anthropic:messages"
            ? tool.input_schema
            : wire === "openai:chatCompletions"
              ? fn?.parameters
              : tool.parameters
        ) as { properties: Record<string, unknown>; required?: unknown };
        return [
          (fn?.name ?? tool.name) as string,
          { names: Object.keys(schema.properties), required: schema.required },
        ];
      }),
    );
  }
});

async function issueNativeQuestion(params: {
  plugin: AppaPluginArchestra;
  context: LlmProxyRequestContext;
  name: string;
}): Promise<string> {
  const trusted = params.context.resources.get(APPA_PLUGIN_TRUSTED_CONTEXT) as {
    request: { tools?: { controlToolName: string; noticeToolName: string } };
  };
  trusted.request.tools ??= {
    controlToolName: "archestra__execute_remedy_plan",
    noticeToolName: "archestra__get_remedy_plans",
  };
  const outcome = await params.plugin.onPrepareToolCalls({
    ...params.context,
    toolCalls: [
      {
        id: "answer",
        name: params.name,
        arguments: "{}",
      },
    ],
  });
  if (outcome?.decision !== "allow") {
    throw new Error("expected native question preparation");
  }
  return outcome.toolCalls[0].id;
}

function requestContext(params: {
  sessionId: string;
  parentId?: string;
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
            parent_id: params.parentId,
          },
          profileId: "profile",
          canonicalizeToolName: params.canonicalizeToolName,
          request: {
            tools: undefined,
            spellings: new Map(),
            platformToolNames: new Set(),
            customTools: new Set(),
            namespaces: new Map(),
          },
        },
      ],
    ]),
  };
}
