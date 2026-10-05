import { afterEach, beforeEach, describe, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { openappaActor } from "@/openappa/actor";
import {
  AppaRewriteReplay,
  captureAppaReplayRequest,
} from "@/openappa/rewrite-replay";
import { verifyRuntimeToolProof } from "@/openappa/runtime-tool-claims";
import * as service from "@/openappa/service";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { AgentRuntimeSchema } from "@/types/agent-runtime";
import { AppaPluginArchestra } from "./plugin";
import {
  APPA_PLUGIN_TRUSTED_CONTEXT,
  APPA_REPLAY_APPROVED_TEXT,
  APPA_REPLAY_ENVELOPE,
  type AppaTrustedContext,
} from "./types";

setupTestCacheManager();
const secret = "runtime-protocol-regression-test-secret";
const priorSecret = config.openappa.offerSigningSecret;
const priorEncryptionSecret = config.secretsManager.encryptionSecret;
beforeEach(() => {
  config.openappa.offerSigningSecret = secret;
});
afterEach(() => {
  config.openappa.offerSigningSecret = priorSecret;
  config.secretsManager.encryptionSecret = priorEncryptionSecret;
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
        runtime: AgentRuntimeSchema.parse({
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
        }),
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
    const body = { messages: [{ role: "user", content: "Do the work" }] };
    const context = { ...request(org.id, true), requestBody: body };
    const trusted = context.resources.get(
      APPA_PLUGIN_TRUSTED_CONTEXT,
    ) as AppaTrustedContext;
    const parentId = trusted.session.parent_id;
    if (!parentId) throw new Error("Expected a runtime parent");
    await db.insert(schema.openappaSessionsTable).values(
      [parentId, trusted.session.session_id].map((sessionId) => ({
        actor: openappaActor(sessionId),
        root: openappaActor(parentId),
        organizationId: org.id,
        callerId: trusted.session.caller_id,
        sessionId,
        ...(sessionId === trusted.session.session_id ? { parentId } : {}),
        startDecision: { decision: "ack" },
      })),
    );
    config.secretsManager.encryptionSecret = secret;
    const replay = await AppaRewriteReplay.open({
      session: trusted.session,
      capture: captureAppaReplayRequest({
        family: "anthropic:messages",
        body,
      }),
      encryptedChat: { kind: "none" },
    });
    context.resources.set(APPA_REPLAY_ENVELOPE, replay);
    const plugin = new AppaPluginArchestra([]);
    const start = vi
      .spyOn(service, "startRuntimeChild")
      .mockResolvedValue({ contract: "Only return an approved summary." });
    const returned = vi
      .spyOn(service, "returnRuntimeValue")
      .mockResolvedValue({ kind: "admitted", value: "Approved summary" });
    const ended = vi.spyOn(service, "endChild");
    await plugin.onSessionInit(context);
    await plugin.onBeforeModel({ ...context, request: body });
    const prepared = await replay.prepareRequest(body);
    expect(JSON.stringify(prepared)).toContain(
      "Only return an approved summary.",
    );
    expect(start).toHaveBeenCalledOnce();
    const sourceResponse = {
      role: "assistant",
      content: [{ type: "text", text: "Unapproved report" }],
    };
    const source = replay.captureResponse(sourceResponse);
    const outcome = await plugin.onBufferedModelResponse({
      ...context,
      response: sourceResponse,
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
    const approvedText = context.resources.get(APPA_REPLAY_APPROVED_TEXT);
    expect(approvedText).toBe("Approved summary");
    if (outcome?.decision !== "replace" || typeof approvedText !== "string")
      throw new Error("Expected an admitted runtime text replacement");
    await replay.recordResponse({
      source,
      response: {
        ...sourceResponse,
        content: [{ type: "text", text: outcome.responseText }],
      },
      emitted: [],
      approvedText,
    });
    await plugin.onCleanup(context);
  });
});

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
