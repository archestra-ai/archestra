import { beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { peerProofAuthorizes, verifyPeerProof } from "@/openappa/peer-claims";
import * as appaService from "@/openappa/service";
import type { LlmProxyRequestContext } from "@/proxy/plugins/registry";
import { setupTestCacheManager } from "@/test/cache-manager";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaPluginArchestra } from "./plugin";
import { APPA_PLUGIN_TRUSTED_CONTEXT, type AppaTrustedContext } from "./types";

describe("AppaPluginArchestra namespace controls", () => {
  setupTestCacheManager();

  beforeEach(async () => {
    config.openappa.enabled = true;
    await GuardrailsDeploymentModel.setEnabled(true);
  });

  test("stamps every accepted alias and matches results by exact namespace, never canonical equality", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = namespaceContext();
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as AppaTrustedContext;
    const tools = trusted.request.tools;
    if (!tools) throw new Error("expected remedy tools");
    tools.controlAliases = ["mcp__gateway", "mcp__legacy"].map((namespace) => ({
      name: tools.control.name,
      namespace,
    }));
    tools.askUserAliases = ["mcp__gateway", "mcp__legacy"].map((namespace) => ({
      name: "archestra__ask_user",
      namespace,
    }));
    trusted.request.declaredTools = [];
    // Deliberately equal canonical names cannot give foreign results a role.
    trusted.toolIdentity.canonicalize = (name) => name;
    const process = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({ toolResultUpdates: {} });
    try {
      await plugin.onSessionInit(context);
      const calls = [
        ...tools.controlAliases,
        ...tools.askUserAliases,
        { name: tools.control.name, namespace: "mcp__foreign" },
        { name: "archestra__ask_user", namespace: "mcp__foreign" },
      ].map((member, index) => ({
        ...member,
        id: `member-${index}`,
        arguments: JSON.stringify(
          member.name === tools.control.name
            ? { offer_id: "offer" }
            : {
                question: "Choose",
                options: [{ label: "Yes" }, { label: "No" }],
                remedy_offer_ids: [`offer-${index}`],
              },
        ),
      }));
      const prepared = await plugin.onPrepareToolCalls({
        ...context,
        toolCalls: calls,
      });
      if (prepared?.decision !== "allow")
        throw new Error("expected alias stamps");
      for (const [index, call] of prepared.toolCalls.entries()) {
        expect(call.name).toBe(calls[index].name);
        expect(call.id).toBe(calls[index].id);
        if (index < 4) {
          expect(JSON.parse(String(call.arguments))).toHaveProperty(
            "trajectory.session_id",
            "session",
          );
        } else {
          expect(call.arguments).toBe(calls[index].arguments);
        }
      }
      const results = calls.map((call) => ({
        ...call,
        arguments: {},
        content: "result",
        isError: false,
      }));
      await plugin.onToolResults({ ...context, toolResults: results });
      const options = process.mock.calls[0]?.[0];
      expect(
        results.map((result) => options?.isControlResult?.(result)),
      ).toEqual([true, true, false, false, false, false]);
      expect(
        results.map((result) => options?.isUserQuestion?.(result)),
      ).toEqual([false, false, true, true, false, false]);
    } finally {
      process.mockRestore();
    }
  });

  test("stamps and bypasses only the declared control namespace", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = namespaceContext();
    const evaluate = vi.spyOn(appaService, "evaluateToolCalls");
    evaluate.mockImplementation(async (_session, calls) =>
      calls.map((call) =>
        call.id === "trusted"
          ? ({ kind: "control" } as const)
          : ({ kind: "allow" } as const),
      ),
    );
    try {
      await plugin.onSessionInit(context);
      const prepared = await plugin.onPrepareToolCalls({
        ...context,
        toolCalls: [
          {
            id: "trusted",
            name: "archestra__execute_remedy_plan",
            namespace: "mcp__gateway",
            arguments: '{"offer_id":"trusted"}',
          },
          {
            id: "foreign",
            name: "archestra__execute_remedy_plan",
            namespace: "mcp__foreign",
            arguments: '{"offer_id":"foreign"}',
          },
        ],
      });

      if (prepared?.decision !== "allow")
        throw new Error("expected prepared calls");
      const [trusted, foreign] = prepared.toolCalls;
      expect(JSON.parse(String(trusted.arguments))).toMatchObject({
        execution: {
          call_id: "trusted",
          tool_name: "archestra__execute_remedy_plan",
          namespace: "mcp__gateway",
        },
        trajectory: { v: 1, session_id: "session" },
      });
      expect(JSON.parse(String(trusted.arguments))).not.toHaveProperty(
        "protected",
      );
      expect(foreign.arguments).toBe('{"offer_id":"foreign"}');

      const outcome = await plugin.onToolCalls({
        ...context,
        toolCalls: prepared.toolCalls,
      });
      expect(outcome).toBeUndefined();
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(evaluate.mock.calls[0]?.[1].map((call) => call.id)).toEqual([
        "trusted",
        "foreign",
      ]);

      evaluate.mockClear();
      const foreignOnly = await plugin.onToolCalls({
        ...context,
        toolCalls: [foreign],
      });
      expect(foreignOnly).toBeUndefined();
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(evaluate.mock.calls[0]?.[1].map((call) => call.id)).toEqual([
        "foreign",
      ]);
    } finally {
      evaluate.mockRestore();
    }
  });

  test("stamps accepted Codex peer aliases with caller/action/message proofs, not foreign namespaces", async () => {
    config.openappa.offerSigningSecret = "namespace-peer-secret";
    const plugin = new AppaPluginArchestra([]);
    const context = namespaceContext();
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as AppaTrustedContext;
    trusted.request.declaredTools = [];
    trusted.toolIdentity.canonicalize = (name, namespace) =>
      namespace === "mcp__gateway" || namespace === "mcp__legacy"
        ? name
        : `foreign:${name}`;
    const evaluate = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockResolvedValue([{ kind: "allow" }]);
    try {
      await plugin.onSessionInit(context);
      const calls = ["mcp__gateway", "mcp__legacy", "mcp__foreign"].map(
        (namespace, index) => ({
          id: `peer-${index}`,
          name: "archestra__read_peer_message",
          namespace,
          arguments: { message_id: "held-message" },
        }),
      );
      const outcome = await plugin.onToolCalls({
        ...context,
        toolCalls: calls,
      });
      if (outcome?.decision !== "allow")
        throw new Error("expected stamped peer calls");
      for (const [index, call] of outcome.toolCalls.entries()) {
        if (index === 2) {
          expect(call).toEqual(calls[index]);
          continue;
        }
        const proof = verifyPeerProof(
          JSON.parse(String(call.arguments)).peer_proof,
          config.openappa.offerSigningSecret,
        );
        expect(proof).toMatchObject({
          organization_id: "organization",
          caller_id: "user:person",
          call_id: calls[index].id,
          session_id: "session",
          action: "read_peer_message",
          message_id: "held-message",
        });
        if (!proof) throw new Error("expected valid peer proof");
        const scope = {
          proof,
          organizationId: "organization",
          callerId: "user:person",
          action: "read_peer_message" as const,
          messageId: "held-message",
        };
        expect(peerProofAuthorizes(scope)).toBe(true);
        expect(peerProofAuthorizes({ ...scope, callerId: "user:other" })).toBe(
          false,
        );
        expect(
          peerProofAuthorizes({ ...scope, organizationId: "other-org" }),
        ).toBe(false);
        expect(
          peerProofAuthorizes({ ...scope, messageId: "other-message" }),
        ).toBe(false);
        expect(
          peerProofAuthorizes({ ...scope, action: "list_peer_messages" }),
        ).toBe(false);
      }
      expect(evaluate.mock.calls[0]?.[1].map((call) => call.namespace)).toEqual(
        ["mcp__foreign"],
      );
    } finally {
      evaluate.mockRestore();
    }
  });

  test("does not classify a foreign same-leaf ask_user as a platform question", async () => {
    const plugin = new AppaPluginArchestra([]);
    const context = namespaceContext();
    const evaluate = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockResolvedValue([{ kind: "allow" }]);
    try {
      await plugin.onSessionInit(context);
      await plugin.onToolCalls({
        ...context,
        toolCalls: [
          {
            id: "read",
            name: "Read",
            arguments: { file_path: "report.txt" },
          },
        ],
      });
      const isQuestion = evaluate.mock.calls[0]?.[2]?.isUserQuestion;
      expect(isQuestion?.("archestra__ask_user", "mcp__gateway")).toBe(true);
      expect(isQuestion?.("archestra__ask_user", "mcp__foreign")).toBe(false);
      expect(isQuestion?.("archestra__ask_user")).toBe(false);
    } finally {
      evaluate.mockRestore();
    }
  });

  test("does not stamp or convert a foreign same-leaf ask_user call", async () => {
    const plugin = new AppaPluginArchestra([new AppaCodexAdapter()]);
    const context = {
      ...namespaceContext(),
      headers: {
        originator: "codex_exec",
        "x-archestra-native-question": "request_user_input",
      },
    };
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    const request = (trusted.request ?? {}) as Record<string, unknown>;
    request.declaredTools = [{ name: "request_user_input" }];
    const foreign = {
      id: "foreign-question",
      name: "archestra__ask_user",
      namespace: "mcp__foreign",
      arguments: JSON.stringify({
        question: "Send this to the foreign server?",
        options: [{ label: "No" }, { label: "Yes" }],
        remedy_offer_ids: ["foreign-offer"],
        trajectory: { v: 1, session_id: "forged-session" },
        remedy_offers: [
          { protected: "echo", payload: "echo", signature: "echo" },
        ],
      }),
    };

    await plugin.onSessionInit(context);
    const prepared = await plugin.onPrepareToolCalls({
      ...context,
      toolCalls: [foreign],
    });
    const calls =
      prepared?.decision === "allow" ? prepared.toolCalls : [foreign];

    expect(calls).toEqual([foreign]);
  });

  test.each([
    true,
    false,
  ])("keeps native question answers separate from foreign namespaces (proxy-only=%s)", async (proxyOnly) => {
    const priorSecret = config.openappa.offerSigningSecret;
    config.openappa.offerSigningSecret = "";
    const plugin = new AppaPluginArchestra([new AppaCodexAdapter()]);
    const context = {
      ...namespaceContext(),
      headers: { originator: "codex_exec" },
    };
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as Record<string, unknown>;
    const request = trusted.request as Record<string, unknown>;
    if (proxyOnly) delete request.tools;
    request.declaredTools = [
      { name: "request_user_input" },
      { name: "request_user_input", namespace: "mcp__other" },
    ];
    const question = {
      id: "call_question",
      name: "request_user_input",
      arguments: "{}",
    };
    // An MCP tool with the same name: the runtime rules on this call, so its
    // result must not skip the result check.
    const lookalike = {
      id: "call_lookalike",
      name: "request_user_input",
      namespace: "mcp__other",
      arguments: "{}",
    };
    const evaluate = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockResolvedValue([{ kind: "allow" }, { kind: "allow" }]);
    const process = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
      });

    try {
      await plugin.onSessionInit(context);
      const prepared = await plugin.onPrepareToolCalls({
        ...context,
        toolCalls: [question, lookalike],
      });

      expect(prepared).toBeUndefined();
      await plugin.onToolCalls({
        ...context,
        toolCalls: [question, lookalike],
      });
      const isQuestionCall = evaluate.mock.calls[0]?.[2]?.isUserQuestion;
      expect(isQuestionCall?.(question.name)).toBe(true);
      expect(isQuestionCall?.(lookalike.name, lookalike.namespace)).toBe(false);

      const nativeAnswer = {
        ...question,
        arguments: {},
        content: "human choice",
        isError: false,
      };
      const foreignAnswer = {
        ...lookalike,
        arguments: {},
        content: "untrusted reply",
        isError: false,
      };
      await plugin.onToolResults({
        ...context,
        toolResults: [nativeAnswer, foreignAnswer],
      });
      const isQuestionResult = process.mock.calls[0]?.[0]?.isUserQuestion;
      expect(isQuestionResult?.(nativeAnswer)).toBe(true);
      expect(isQuestionResult?.(foreignAnswer)).toBe(false);
    } finally {
      evaluate.mockRestore();
      process.mockRestore();
      config.openappa.offerSigningSecret = priorSecret;
    }
  });
});

function namespaceContext(): LlmProxyRequestContext {
  return {
    requestId: "namespace-request",
    organizationId: "organization",
    profileId: "profile",
    provider: "openai",
    interactionType: "openai:responses",
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
            caller_id: "user:person",
            session_id: "session",
          },
          profileId: "profile",
          toolIdentity: {
            canonicalize: (name: string) => name,
            attestationOf: () => undefined,
            looseRunToolDispatch: false,
          },
          request: {
            tools: {
              control: {
                name: "archestra__execute_remedy_plan",
                namespace: "mcp__gateway",
              },
              notice: {
                name: "archestra__get_remedy_plans",
                namespace: "mcp__gateway",
              },
              askUser: {
                name: "archestra__ask_user",
                namespace: "mcp__gateway",
              },
              platformToolNames: new Set(["archestra__ask_user"]),
            },
            session: {},
            spellings: new Map(),
            customTools: new Set(),
            namespaces: new Map([
              ["archestra__execute_remedy_plan", "mcp__gateway"],
              ["archestra__get_remedy_plans", "mcp__gateway"],
            ]),
            foreignControlTools: [
              {
                name: "archestra__execute_remedy_plan",
                namespace: "mcp__foreign",
              },
            ],
          },
        },
      ],
    ]),
  };
}
