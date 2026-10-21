import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, vi } from "vitest";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import config from "@/config";
import db, { schema } from "@/database";
import OpenAppaSpawnCorrelationModel from "@/models/openappa-spawn-correlation";
import OpenAppaUnenforcedModel from "@/models/openappa-unenforced";
import * as agentRuntimeMetrics from "@/observability/metrics/agent-runtime";
import { openappaActor } from "@/openappa/actor";
import { verifyRuntimeToolProof } from "@/openappa/runtime-tool-claims";
import * as service from "@/openappa/service";
import * as unenforced from "@/openappa/unenforced";
import { LlmProxyPluginRegistry } from "@/proxy/plugins/registry";
import { resolveGatewayToolIdentity } from "@/routes/proxy/utils/gateway-tool-names";
import { pendingExports } from "@/services/agent-runtime/pending-exports";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { AgentRuntimeSchema } from "@/types/agent-runtime";
import type { RuntimeLaunchOutcome } from "@/types/openappa-runtime-launch";
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
  test("signs a runtime call it observes while enforcement is off, and never a launch", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      runtime: runtimeConfig(),
    });
    const context = request(org.id);
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as AppaTrustedContext;
    trusted.enforcement = "inactive";
    // A governed session that keeps working while enforcement is off.
    await db.insert(schema.openappaSessionsTable).values({
      organizationId: org.id,
      callerId: trusted.session.caller_id,
      sessionId: trusted.session.session_id,
      actor: openappaActor(trusted.session.session_id),
      root: openappaActor(trusted.session.session_id),
      parentId: null,
      startDecision: { decision: "ack" },
    });
    const plugin = new AppaPluginArchestra([]);
    await plugin.onSessionInit(context);
    const counted = vi.spyOn(
      agentRuntimeMetrics,
      "reportAgentRuntimeObservedReads",
    );
    const launch = { agent_id: agent.id, prompt: "Private report" };
    const outcome = await plugin.onToolCalls({
      ...context,
      toolCalls: [
        {
          id: "observed-read",
          name: "archestra__get_agent_run",
          arguments: { task_id: "task-one" },
        },
        {
          id: "observed-launch",
          name: "archestra__start_agent_run",
          arguments: launch,
        },
        {
          id: "observed-steer",
          name: "archestra__steer_agent_run",
          arguments: { task_id: "task-one", message: "keep going" },
        },
        {
          id: "observed-forged",
          name: "archestra__get_agent_run",
          arguments: { task_id: "task-one", runtime_proof: "model-written" },
        },
      ],
    });

    if (outcome?.decision !== "allow") throw new Error("nothing was signed");
    const [read, spawn, steer, forged] = outcome.toolCalls;
    // Only reads are signed while nothing rules them; a launch or a steer is
    // made again under a ruling, and a proof the model wrote is not replaced.
    expect(spawn.arguments).toEqual(launch);
    expect(steer.arguments).toEqual({
      task_id: "task-one",
      message: "keep going",
    });
    expect(forged.arguments).toEqual({
      task_id: "task-one",
      runtime_proof: "model-written",
    });
    const signed = read.arguments as Record<string, unknown>;
    expect(
      verifyRuntimeToolProof({
        proof: signed.runtime_proof,
        organizationId: org.id,
        callerId: "user:owner",
        action: "get_agent_run",
        arguments: signed,
        secret,
      }),
    ).toMatchObject({
      toolCallId: "observed-read",
      spawn: false,
      observed: true,
    });
    // The record the gateway checks an observed proof by.
    await expect(
      OpenAppaUnenforcedModel.findCalls({
        organizationId: org.id,
        sessionIds: [trusted.session.session_id],
        toolCallIds: ["observed-read"],
      }),
    ).resolves.toEqual([expect.objectContaining({ reason: "made" })]);
    expect(counted).toHaveBeenCalledWith("signed", 1);
  });

  test("leaves a read unsigned and counts it when its call could not be recorded", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const context = request(org.id);
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as AppaTrustedContext;
    trusted.enforcement = "inactive";
    await db.insert(schema.openappaSessionsTable).values({
      organizationId: org.id,
      callerId: trusted.session.caller_id,
      sessionId: trusted.session.session_id,
      actor: openappaActor(trusted.session.session_id),
      root: openappaActor(trusted.session.session_id),
      parentId: null,
      startDecision: { decision: "ack" },
    });
    const plugin = new AppaPluginArchestra([]);
    await plugin.onSessionInit(context);
    vi.spyOn(unenforced, "recordUnenforcedCalls").mockRejectedValue(
      new Error("database unavailable"),
    );
    const counted = vi.spyOn(
      agentRuntimeMetrics,
      "reportAgentRuntimeObservedReads",
    );

    const outcome = await plugin.onToolCalls({
      ...context,
      toolCalls: [
        {
          id: "unrecorded-read",
          name: "archestra__get_agent_run",
          arguments: { task_id: "task-one" },
        },
      ],
    });

    // Without the record the gateway would refuse the proof: sign nothing.
    expect(outcome).toBeUndefined();
    expect(counted).toHaveBeenCalledWith("unsigned", 1);
    expect(counted).toHaveBeenCalledWith("signed", 0);
  });

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
            arguments: {
              tool_name: "archestra__start_agent_run",
              tool_args: args,
            },
          }
        : {
            id: "spawn-one",
            name: "archestra__start_agent_run",
            arguments: args,
          };
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
          action: "start_agent_run",
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
          action: "start_agent_run",
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
      { tool: "start_agent_run", spawn: true, wrapped: true },
      { tool: "get_agent_run", spawn: false, wrapped: false },
      { tool: "get_agent_run", spawn: false, wrapped: true },
      { tool: "list_agent_runs", spawn: false, wrapped: true },
      { tool: "steer_agent_run", spawn: false, wrapped: true },
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
            ...(wrapped ? [] : ["archestra__get_agent_run"]),
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
          : tool === "list_agent_runs"
            ? { agent_id: agent.id }
            : {
                task_id: "example-run",
                ...(tool === "steer_agent_run"
                  ? { message: "Continue the work" }
                  : {}),
              };

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

  // A model can send run_tool's tool_args as JSON text, or leave them out.
  // The gateway reads the text as the target's arguments and defaults missing
  // ones to {}, so the proof must sign those arguments and the registry must
  // release the signed call unchanged otherwise.
  for (const shape of ["object", "json-text", "omitted"] as const) {
    test(`releases a signed runtime call through run_tool (tool_args=${shape})`, async ({
      makeOrganization,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({
        organizationId: org.id,
        runtime: runtimeConfig(),
      });
      const registry = new LlmProxyPluginRegistry();
      registry.register(new AppaPluginArchestra([]));
      const context = request(org.id);
      vi.spyOn(service, "evaluateToolCalls").mockResolvedValue([
        { kind: "allow" },
      ]);
      await registry.onSessionInit(context);
      const tool = shape === "omitted" ? "list_agent_runs" : "start_agent_run";
      const args =
        shape === "omitted"
          ? {}
          : { agent_id: agent.id, message: 'Fix "T-1" and report.\n' };
      const wrapper = {
        tool_name: `archestra__${tool}`,
        ...(shape === "object" ? { tool_args: args } : {}),
        ...(shape === "json-text" ? { tool_args: JSON.stringify(args) } : {}),
      };

      const released = await registry.onToolCalls({
        ...context,
        // An Anthropic stream hands the call over as the text it accumulated.
        toolCalls: [
          {
            id: "runtime-call",
            name: "archestra__run_tool",
            arguments: JSON.stringify(wrapper),
          },
        ],
      });

      if (released.decision !== "allow")
        throw new Error("Expected a released runtime call");
      const wire = released.toolCalls[0].arguments as Record<string, unknown>;
      expect(wire.tool_name).toBe(`archestra__${tool}`);
      const signed =
        typeof wire.tool_args === "string"
          ? (JSON.parse(wire.tool_args) as Record<string, unknown>)
          : (wire.tool_args as Record<string, unknown>);
      expect(typeof wire.tool_args).toBe(
        shape === "json-text" ? "string" : "object",
      );
      const { runtime_proof: proof, ...rest } = signed;
      expect(rest).toEqual(args);
      expect(
        verifyRuntimeToolProof({
          proof,
          arguments: signed,
          organizationId: org.id,
          callerId: "user:owner",
          action: tool,
          secret,
        }),
      ).toMatchObject({ toolCallId: "runtime-call" });
    });
  }

  test("releases run_tool arguments it cannot read unchanged and unsigned", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const registry = new LlmProxyPluginRegistry();
    registry.register(new AppaPluginArchestra([]));
    const context = request(org.id);
    vi.spyOn(service, "evaluateToolCalls").mockResolvedValue([
      { kind: "allow" },
    ]);
    await registry.onSessionInit(context);
    const call = {
      id: "runtime-call",
      name: "archestra__run_tool",
      arguments: JSON.stringify({
        tool_name: "archestra__start_agent_run",
        tool_args: '{"agent_id": "cut off',
      }),
    };

    const released = await registry.onToolCalls({
      ...context,
      toolCalls: [call],
    });

    // run_tool refuses these arguments, so the model gets that error.
    if (released.decision !== "allow")
      throw new Error("Expected a released call");
    expect(released.toolCalls[0].arguments).toBe(call.arguments);
  });

  // After a launch, the model reads what the gateway recorded for the call.
  // The result the client sends back is not read: not its form, not its text.
  test("gives the model the run the gateway recorded, not the one the client reports", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const sessionId = randomUUID();
    const { plugin, context } = await releasedLaunch(org.id, {
      kind: "launched",
      session_id: sessionId,
      state: "submitted",
    });

    const outcome = await plugin.onToolResults({
      ...context,
      toolResults: [
        {
          id: "runtime-call",
          name: "archestra__run_tool",
          // The frame Codex puts around a tool result.
          content: `Wall time: 0.1793 seconds\nOutput:\n${JSON.stringify({
            session_id: randomUUID(),
          })}`,
          isError: false,
        },
      ],
    });

    expect(
      JSON.parse(String(outcome?.toolResultUpdates["runtime-call"])),
    ).toEqual({
      run_id: sessionId,
      state: "submitted",
      run_url: expect.stringMatching(new RegExp(`/chat/runs/${sessionId}$`)),
      next_step: expect.any(String),
    });
  });

  test("tells the model why the gateway started no run", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const setupUrl = "http://localhost:3000/agents/example?setup=credentials";
    const { plugin, context, processed } = await releasedLaunch(org.id, {
      kind: "failed",
      reason: "credentials_needed",
      setup_url: setupUrl,
    });
    const reported = {
      id: "runtime-call",
      name: "archestra__run_tool",
      content: "Error: text that the client reports",
      // The record decides, whatever the client says about the call.
      isError: false,
    };
    // The runtime withholds the output of a spawn that failed.
    processed.mockResolvedValue({
      toolResultUpdates: {
        "runtime-call": {
          content:
            "[appa] Tool output withheld: the spawn did not take: no prepared fork to open this child",
          outputSource: "runtime",
        },
      },
    });

    const outcome = await plugin.onToolResults({
      ...context,
      toolResults: [reported],
    });

    expect(outcome?.toolResultUpdates["runtime-call"]).toBe(
      `No runtime was started. This Agent's Agent Runtime needs credentials that are not set up yet. Put this link in your reply text, never inside a question form, so the user can add them, then start the run again: ${setupUrl}`,
    );
    expect(processed.mock.calls[0][0].classifySpawnResult?.(reported)).toBe(
      "failed",
    );
  });

  test("gives the model no handle when the gateway recorded no launch", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const { plugin, context } = await releasedLaunch(org.id);

    const outcome = await plugin.onToolResults({
      ...context,
      toolResults: [
        {
          id: "runtime-call",
          name: "archestra__run_tool",
          content: JSON.stringify({ session_id: randomUUID() }),
          isError: false,
        },
      ],
    });

    expect(outcome?.toolResultUpdates["runtime-call"]).toBe(
      "The runtime launch returned no verifiable handle.",
    );
  });

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

  test("releases files pinned for a runtime on the runtime's own request, and only there", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    vi.spyOn(service, "startRuntimeChild").mockResolvedValue({});
    const drain = vi.spyOn(pendingExports, "drain").mockResolvedValue();
    const plugin = new AppaPluginArchestra([]);
    const body = { messages: [{ role: "user", content: "continue" }] };

    const runtime = request(org.id, true);
    await plugin.onSessionInit(runtime);
    await plugin.onBeforeModel({ ...runtime, request: body });
    const { session } = runtime.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as AppaTrustedContext;
    expect(drain).toHaveBeenCalledExactlyOnceWith(session);

    const root = request(org.id);
    await plugin.onSessionInit(root);
    await plugin.onBeforeModel({ ...root, request: body });
    expect(drain).toHaveBeenCalledOnce();
  });
});

/**
 * A session whose `start_agent_run` call, sent through `run_tool`, was released,
 * with the outcome the gateway recorded for it, if any.
 */
async function releasedLaunch(
  organizationId: string,
  recorded?: RuntimeLaunchOutcome,
) {
  const context = request(organizationId);
  const { session } = context.resources.get(
    APPA_PLUGIN_TRUSTED_CONTEXT,
  ) as AppaTrustedContext;
  await db.insert(schema.openappaSessionsTable).values({
    organizationId,
    callerId: session.caller_id,
    sessionId: session.session_id,
    actor: openappaActor(session.session_id),
    root: openappaActor(session.session_id),
    parentId: null,
    startDecision: { decision: "ack" },
  });
  await db.insert(schema.openappaOperationsTable).values({
    organizationId,
    callerId: session.caller_id,
    sessionId: session.session_id,
    operationId: "call:runtime-call",
    root: openappaActor(session.session_id),
    status: "complete",
    input: {
      semantic: {
        event: "tool_call",
        tool: "archestra__start_agent_run",
        spawn: true,
      },
    },
    decision: { decision: "allow_call" },
  });
  if (recorded) {
    await OpenAppaSpawnCorrelationModel.recordRuntimeLaunch({
      organizationId,
      callerId: session.caller_id,
      sessionId: session.session_id,
      toolCallId: "runtime-call",
      outcome: recorded,
    });
  }
  vi.spyOn(service, "loadChildReturns").mockResolvedValue([]);
  const processed = vi
    .spyOn(service, "processProxyResults")
    .mockResolvedValue({ toolResultUpdates: {} });
  const plugin = new AppaPluginArchestra([]);
  await plugin.onSessionInit(context);
  return { plugin, context, processed };
}

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
          "archestra__start_agent_run",
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
