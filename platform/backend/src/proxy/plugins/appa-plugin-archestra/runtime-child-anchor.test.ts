import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";
import { childSessionId } from "@/openappa/actor";
import { currentTrajectory } from "@/openappa/current-trajectory";
import { mintDelegationMarker } from "@/openappa/delegation";
import { prepareAppaRequest } from "@/openappa/request";
import * as appaService from "@/openappa/service";
import type {
  LlmProxyRequestContext,
  LlmProxyToolCallsContext,
} from "@/proxy/plugins/registry";
import { setupTestCacheManager } from "@/test/cache-manager";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";
import {
  APPA_CHILD_TRAJECTORY_RECEIPT,
  APPA_PLUGIN_TRUSTED_CONTEXT,
  type AppaChildTrajectoryReceiptOutput,
  type AppaTrustedContext,
} from "./types";

setupTestCacheManager();

const SECRET = "runtime-anchor-secret-0123456789abcdef";
const CALLER = "user:user";
const WORKSPACE = "workspace";

describe("runtime workspace child anchor", () => {
  const priorSecret = config.openappa.offerSigningSecret;

  beforeEach(() => {
    config.openappa.enabled = true;
    config.openappa.offerSigningSecret = SECRET;
  });

  afterEach(() => {
    config.openappa.offerSigningSecret = priorSecret;
  });

  test("admits a Claude child's tool result and return on the workspace child, and routes controls for that child", async () => {
    const plugin = new AppaPluginArchestra([
      new AppaClaudeCodeAdapter(),
      new AppaCodexAdapter(),
      new AppaOpenCodeAdapter(),
    ]);
    const marker = mintDelegationMarker({
      organizationId: "org",
      callerId: CALLER,
      parentId: WORKSPACE,
      spawnerNativeId: "s1",
      prompt: "inspect the failure",
      spawnCallId: "spawn-call",
    });
    const context = childRequest({
      headers: {
        "user-agent": "claude-code/1",
        "x-claude-code-session-id": "s1",
        "x-claude-code-agent-id": "a1",
        "x-appa-session-id": WORKSPACE,
      },
      interactionType: "anthropic:messages",
      body: {
        messages: [
          {
            role: "user",
            content: `inspect the failure\n\n${marker}`,
          },
        ],
      },
    });
    const evaluate = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockResolvedValue([
        {
          kind: "deny",
          feedback: "[appa] Blocked",
          offers: ["offer-1"],
        },
      ]);
    const results = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: true,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    const ended = vi.spyOn(appaService, "endChild").mockResolvedValue({
      decision: "release",
      crossed: true,
    });
    try {
      await plugin.onSessionInit(context);
      const childId = `${CALLER}|${childSessionId(WORKSPACE, "a1")}`;
      const parentId = `${CALLER}|${WORKSPACE}`;
      const receipt = context.resources.get(APPA_CHILD_TRAJECTORY_RECEIPT) as
        | AppaChildTrajectoryReceiptOutput
        | undefined;
      const payload = receipt?.footer.match(
        /appact2-([A-Za-z0-9_-]+)\.[0-9a-f]{64}\./,
      )?.[1];
      expect(payload).toBeDefined();
      const claims = JSON.parse(
        Buffer.from(payload ?? "", "base64url").toString(),
      ) as string[];
      expect(claims).toContain(WORKSPACE);
      expect(claims).toContain(childSessionId(WORKSPACE, "a1"));
      expect(claims).toContain("s1");

      const denied = await plugin.onToolCalls({
        ...context,
        toolCalls: [
          { id: "call-1", name: "Bash", arguments: { command: "ls" } },
        ],
      });
      if (denied?.decision !== "allow") throw new Error("expected a notice");
      const notice = JSON.parse(String(denied.toolCalls[0]?.arguments)) as {
        tool: string;
        ruling: string;
      };
      expect(notice).toMatchObject({
        tool: "Bash",
        ruling: expect.stringContaining("Blocked"),
      });
      const prepared = await plugin.onPrepareToolCalls({
        ...context,
        toolCalls: [
          {
            id: "control",
            name: "archestra__execute_remedy_plan",
            arguments: {
              offer_id: "offer-1",
              trajectory: { v: 1, session_id: "untrusted-model-root" },
            },
          },
        ],
      });
      if (prepared?.decision !== "allow")
        throw new Error("expected trusted child routing");
      const args =
        typeof prepared.toolCalls[0].arguments === "string"
          ? JSON.parse(prepared.toolCalls[0].arguments)
          : prepared.toolCalls[0].arguments;
      expect(args.trajectory).toEqual(
        currentTrajectory({
          session_id: childId,
          parent_id: parentId,
        }),
      );

      await plugin.onToolResults({
        ...context,
        toolResults: [
          { id: "call-1", name: "Bash", content: "listed", isError: false },
        ],
      });
      expect(results.mock.calls[0]?.[0].session).toMatchObject({
        session_id: childId,
        parent_id: parentId,
      });

      await plugin.onToolCalls({
        ...context,
        toolCalls: [
          {
            id: "handback",
            name: "SubagentHandback",
            arguments: { message: "child finished" },
          },
        ],
      });
      expect(ended).toHaveBeenCalledWith(
        expect.objectContaining({
          session: expect.objectContaining({
            session_id: childId,
            parent_id: parentId,
          }),
          output: "child finished",
        }),
      );
    } finally {
      evaluate.mockRestore();
      results.mockRestore();
      ended.mockRestore();
    }
  });

  test("admits Codex and OpenCode tool results on their workspace children", async () => {
    const plugin = new AppaPluginArchestra([
      new AppaCodexAdapter(),
      new AppaOpenCodeAdapter(),
    ]);
    const results = vi
      .spyOn(appaService, "processProxyResults")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: true,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    try {
      const codex = childRequest({
        headers: {
          "user-agent": "codex_cli_rs/0.99.0",
          "x-codex-turn-metadata": JSON.stringify({
            parent_thread_id: "t0",
            thread_id: "t1",
          }),
          "x-appa-session-id": WORKSPACE,
        },
        interactionType: "openai:responses",
        body: { input: [] },
      });
      const openCode = childRequest({
        headers: {
          "user-agent": "opencode/1.18.31",
          "x-opencode-session": "c",
          "x-session-id": "p",
          "x-appa-session-id": WORKSPACE,
        },
        interactionType: "openai:chatCompletions",
        body: { messages: [] },
      });
      await plugin.onSessionInit(codex);
      await plugin.onSessionInit(openCode);
      await plugin.onToolResults({
        ...codex,
        toolResults: [
          { id: "call-1", name: "shell", content: "ok", isError: false },
        ],
      });
      await plugin.onToolResults({
        ...openCode,
        toolResults: [
          { id: "call-2", name: "bash", content: "ok", isError: false },
        ],
      });
      expect(
        results.mock.calls.map(([input]) => input.session.session_id),
      ).toEqual([
        `${CALLER}|${childSessionId(WORKSPACE, "t1")}`,
        `${CALLER}|${childSessionId(WORKSPACE, "c")}`,
      ]);
      expect(
        results.mock.calls.map(([input]) => input.session.parent_id),
      ).toEqual([`${CALLER}|${WORKSPACE}`, `${CALLER}|${WORKSPACE}`]);
    } finally {
      results.mockRestore();
    }
  });

  test("binds a second native child to a different workspace child id", async () => {
    const plugin = new AppaPluginArchestra([new AppaClaudeCodeAdapter()]);
    const evaluate = vi
      .spyOn(appaService, "evaluateToolCalls")
      .mockImplementation(async (_session, calls) =>
        calls.map(() => ({ kind: "allow" as const })),
      );
    try {
      const first = childRequest({
        headers: {
          "user-agent": "claude-code/1",
          "x-claude-code-session-id": "s1",
          "x-claude-code-agent-id": "a1",
          "x-appa-session-id": WORKSPACE,
        },
        interactionType: "anthropic:messages",
        body: { messages: [] },
      });
      const second = childRequest({
        headers: {
          "user-agent": "claude-code/1",
          "x-claude-code-session-id": "s1",
          "x-claude-code-agent-id": "a2",
          "x-appa-session-id": WORKSPACE,
        },
        interactionType: "anthropic:messages",
        body: { messages: [] },
      });
      await plugin.onSessionInit(first);
      await plugin.onSessionInit(second);
      await plugin.onToolCalls(calls(first, "a1"));
      await plugin.onToolCalls(calls(second, "a2"));
      expect(
        evaluate.mock.calls.map(([session]) => session.session_id),
      ).toEqual([
        `${CALLER}|${childSessionId(WORKSPACE, "a1")}`,
        `${CALLER}|${childSessionId(WORKSPACE, "a2")}`,
      ]);
    } finally {
      evaluate.mockRestore();
    }
  });
});

function calls(
  context: LlmProxyRequestContext,
  id: string,
): LlmProxyToolCallsContext {
  return {
    ...context,
    toolCalls: [{ id, name: "Bash", arguments: {} }],
  };
}

function childRequest(params: {
  headers: Record<string, string>;
  interactionType: string;
  body: unknown;
}): LlmProxyRequestContext {
  const resources = new Map<PropertyKey, unknown>();
  const trusted: AppaTrustedContext = {
    session: {
      organization_id: "org",
      caller_id: CALLER,
      session_id: `${CALLER}|${WORKSPACE}`,
      parent_id: `${CALLER}|conversation`,
    },
    profileId: "profile",
    toolIdentity: {
      canonicalize: (name) => name,
      attestationOf: () => undefined,
      looseRunToolDispatch: false,
    },
    request: {
      ...prepareAppaRequest({
        body: params.body,
        interactionType: params.interactionType,
        identity: {
          mode: "compat",
          gatewayConnected: true,
          canonicalize: (name) => name,
          attestationOf: () => undefined,
          verified: [],
          unverifiedMarkerCount: 0,
        },
      }),
      tools: {
        control: { name: "archestra__execute_remedy_plan" },
        notice: { name: "archestra__get_remedy_plans" },
        askUser: undefined,
        platformToolNames: new Set(),
        namespaces: new Map(),
      },
      turnEndOperationId: "turn_end:runtime-child",
    },
    claims: { sessionId: WORKSPACE },
    enforcement: "active",
  };
  resources.set(APPA_PLUGIN_TRUSTED_CONTEXT, trusted);
  return {
    requestId: "runtime-child",
    organizationId: "org",
    profileId: "profile",
    provider: "anthropic",
    interactionType: params.interactionType,
    model: "model",
    streaming: false,
    headers: params.headers,
    requestBody: params.body,
    resources,
  };
}
