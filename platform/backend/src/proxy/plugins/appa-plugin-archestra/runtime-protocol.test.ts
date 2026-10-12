import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, vi } from "vitest";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import config from "@/config";
import { verifyRuntimeToolProof } from "@/openappa/runtime-tool-claims";
import * as service from "@/openappa/service";
import { resolveGatewayToolIdentity } from "@/routes/proxy/utils/gateway-tool-names";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { AgentRuntimeSchema } from "@/types/agent-runtime";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaPluginArchestra } from "./plugin";
import { APPA_PLUGIN_TRUSTED_CONTEXT, type AppaTrustedContext } from "./types";

setupTestCacheManager();
const secret = "runtime-protocol-regression-test-secret";
const priorSecret = config.openappa.offerSigningSecret;
beforeEach(() => {
  config.openappa.offerSigningSecret = secret;
});
afterEach(() => {
  config.openappa.offerSigningSecret = priorSecret;
  vi.restoreAllMocks();
});

describe("protected runtime protocol", () => {
  for (const wrapped of [false, true]) {
    test(`stamps the released runtime spawn's real source (wrapped=${wrapped})`, async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({
        organizationId: org.id,
        runtime: runtimeConfig(),
      });
      const plugin = new AppaPluginArchestra([]);
      const context = request(org.id);
      const evaluate = vi
        .spyOn(service, "evaluateToolCalls")
        .mockResolvedValue([{ kind: "allow" }]);
      await plugin.onSessionInit(context);
      const args = { agent_id: agent.id, prompt: "Private report" };
      const call = wrapped
        ? {
            id: "spawn-one",
            name: "archestra__run_tool",
            arguments: { tool_name: "archestra__start_run", tool_args: args },
          }
        : { id: "spawn-one", name: "archestra__start_run", arguments: args };
      const released = await plugin.onToolCalls({
        ...context,
        toolCalls: [call],
      });
      expect(evaluate.mock.calls[0][2]?.spawnCallIds?.has("spawn-one")).toBe(
        true,
      );
      expect(evaluate.mock.calls[0][2]?.supportsDelegation).toBe(true);
      if (released?.decision !== "allow")
        throw new Error("Expected a governed released call");
      const wire = released.toolCalls[0].arguments as Record<string, unknown>;
      const target = wrapped
        ? (wire.tool_args as Record<string, unknown>)
        : wire;
      expect(
        verifyRuntimeToolProof({
          proof: target.runtime_proof,
          arguments: target,
          organizationId: org.id,
          callerId: "user:owner",
          action: "start_run",
          secret,
        }),
      ).toEqual({
        session: (
          context.resources.get(
            APPA_PLUGIN_TRUSTED_CONTEXT,
          ) as AppaTrustedContext
        ).session,
        toolCallId: "spawn-one",
        spawn: true,
      });
      expect(
        verifyRuntimeToolProof({
          proof: target.runtime_proof,
          arguments: { ...target, prompt: "Changed report" },
          organizationId: org.id,
          callerId: "user:owner",
          action: "start_run",
          secret,
        }),
      ).toBeNull();
    });
  }

  // An external client declares the gateway's tools under its own label, and
  // reaches a runtime tool the gateway does not list through `run_tool`.
  for (const client of [
    {
      label: "Codex",
      adapter: () => new AppaCodexAdapter(),
      headers: { originator: "codex_exec" },
      spelling: (name: string) => ({ name, namespace: "mcp__my_gateway" }),
    },
    {
      label: "Claude Code",
      adapter: () => new AppaClaudeCodeAdapter(),
      headers: { "user-agent": "claude-cli/2.1.0" },
      spelling: (name: string) => ({ name: `mcp__my_gateway__${name}` }),
    },
  ]) {
    for (const { tool, spawn, wrapped } of [
      { tool: "start_run", spawn: true, wrapped: true },
      { tool: "get_run", spawn: false, wrapped: false },
    ]) {
      test(`signs ${tool} from ${client.label} behind an attested gateway (wrapped=${wrapped})`, async ({
        makeOrganization,
        makeAgent,
      }) => {
        const org = await makeOrganization();
        const agent = await makeAgent({
          organizationId: org.id,
          runtime: runtimeConfig(),
        });
        const gatewayId = randomUUID();
        const toolIdentity = await resolveGatewayToolIdentity({
          organizationId: org.id,
          declarations: [
            "archestra__run_tool",
            "archestra__get_run",
            "archestra__get_remedy_plans",
            "archestra__execute_remedy_plan",
          ].map((name) => ({
            ...client.spelling(name),
            marker: attestToolDescription({
              organizationId: org.id,
              gatewayId,
              advertisedName: name,
              kind: "b",
              description: undefined,
            }),
          })),
          internalChat: false,
        });
        expect(toolIdentity.mode).toBe("attested");
        const context = request(org.id);
        context.headers = { ...context.headers, ...client.headers };
        const trusted = context.resources.get(
          APPA_PLUGIN_TRUSTED_CONTEXT,
        ) as AppaTrustedContext;
        trusted.toolIdentity = toolIdentity;
        const plugin = new AppaPluginArchestra([client.adapter()]);
        const evaluate = vi
          .spyOn(service, "evaluateToolCalls")
          .mockResolvedValue([{ kind: "allow" }]);
        await plugin.onSessionInit(context);
        const args = spawn
          ? { agent_id: agent.id, message: "Do the work" }
          : { task_id: "example-run" };

        const released = await plugin.onToolCalls({
          ...context,
          toolCalls: [
            wrapped
              ? {
                  id: "runtime-call",
                  ...client.spelling("archestra__run_tool"),
                  arguments: {
                    tool_name: `archestra__${tool}`,
                    tool_args: args,
                  },
                }
              : {
                  id: "runtime-call",
                  ...client.spelling(`archestra__${tool}`),
                  arguments: args,
                },
          ],
        });

        expect(
          evaluate.mock.calls[0][2]?.spawnCallIds?.has("runtime-call"),
        ).toBe(spawn);
        if (released?.decision !== "allow")
          throw new Error("Expected a governed released call");
        const wire = released.toolCalls[0].arguments as Record<string, unknown>;
        const signed = wrapped
          ? (wire.tool_args as Record<string, unknown>)
          : wire;
        expect(
          verifyRuntimeToolProof({
            proof: signed.runtime_proof,
            arguments: signed,
            organizationId: org.id,
            callerId: "user:owner",
            action: tool,
            secret,
          }),
        ).toMatchObject({ toolCallId: "runtime-call", spawn });
      });
    }
  }

  test("does not reserve a runtime fork for an in-process delegated agent", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({ organizationId: org.id, name: "Local helper" });
    const plugin = new AppaPluginArchestra([]);
    const context = request(org.id);
    const evaluate = vi
      .spyOn(service, "evaluateToolCalls")
      .mockResolvedValue([{ kind: "allow" }]);
    await plugin.onSessionInit(context);
    await plugin.onToolCalls({
      ...context,
      toolCalls: [
        {
          id: "delegate",
          name: "agent__local-helper",
          arguments: { prompt: "Report" },
        },
      ],
    });
    expect(evaluate.mock.calls[0][2]?.spawnCallIds?.size).toBe(0);
  });

  test("delivers the retained return contract before inference and does not end the retained runtime", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const context = request(org.id, true);
    const plugin = new AppaPluginArchestra([]);
    const start = vi
      .spyOn(service, "startRuntimeChild")
      .mockResolvedValue({ contract: "Only return an approved summary." });
    const returned = vi
      .spyOn(service, "returnRuntimeValue")
      .mockResolvedValue({ kind: "admitted", value: "Approved summary" });
    const ended = vi.spyOn(service, "endChild");
    await plugin.onSessionInit(context);
    const body = { messages: [{ role: "user", content: "Do the work" }] };
    await plugin.onBeforeModel({ ...context, request: body });
    expect(JSON.stringify(body)).toContain("Only return an approved summary.");
    expect(start).toHaveBeenCalledOnce();
    const outcome = await plugin.onBufferedModelResponse({
      ...context,
      response: {},
      responseText: "Unapproved report",
    });
    expect(outcome).toEqual({
      decision: "replace",
      responseText: "Approved summary",
    });
    expect(returned).toHaveBeenCalledWith({
      session: expect.objectContaining({ parent_id: "user:owner|parent" }),
      operationId: "runtime-return:task-one:request-one",
      value: "Unapproved report",
    });
    expect(ended).not.toHaveBeenCalled();
  });
});

function runtimeConfig() {
  return AgentRuntimeSchema.parse({
    image: "runtime:test",
    command: null,
    inferenceProtocol: "anthropic",
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    idleTimeoutMinutes: null,
  });
}

function request(organizationId: string, runtime = false) {
  const session = {
    organization_id: organizationId,
    caller_id: "user:owner",
    session_id: "user:owner|workspace",
    ...(runtime ? { parent_id: "user:owner|parent" } : {}),
  };
  const resources = new Map<PropertyKey, unknown>();
  const trusted: AppaTrustedContext = {
    session,
    profileId: "profile",
    enforcement: "active",
    ...(runtime
      ? { runtimeSessionId: session.session_id, runtimeTaskId: "task-one" }
      : {}),
    claims: { sessionId: "workspace" },
    toolIdentity: {
      canonicalize: (name) => name,
      attestationOf: () => undefined,
      looseRunToolDispatch: true,
    },
    request: {
      session: { sessionId: "workspace" },
      customTools: new Set(),
      declaredTools: [],
      turnEndOperationId: "turn_end:request-one",
      tools: {
        control: { name: "archestra__execute_remedy_plan" },
        notice: { name: "archestra__get_remedy_plans" },
        askUser: undefined,
        platformToolNames: new Set([
          "archestra__start_run",
          "archestra__run_tool",
        ]),
        namespaces: new Map(),
      },
    },
  };
  resources.set(APPA_PLUGIN_TRUSTED_CONTEXT, trusted);
  return {
    requestId: "request-one",
    organizationId,
    profileId: "profile",
    provider: "anthropic",
    interactionType: "anthropic:messages",
    model: "model",
    streaming: false,
    headers: { "x-appa-session-id": "workspace" },
    requestBody: { messages: [] },
    resources,
  };
}
