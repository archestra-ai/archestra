import * as appaService from "@/openappa/service";
import type { LlmProxyRequestContext } from "@/proxy/plugins/registry";
import { describe, expect, test, vi } from "@/test";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaPluginArchestra } from "./plugin";
import { APPA_PLUGIN_TRUSTED_CONTEXT } from "./types";

describe("AppaPluginArchestra namespace controls", () => {
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
      });
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
