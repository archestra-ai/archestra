import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { vi } from "vitest";
import config from "@/config";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { scopedSessionId } from "@/openappa/actor";
import { isUnenforcedSession } from "@/openappa/unenforced";
import { resolveGatewayToolIdentity } from "@/routes/proxy/utils/gateway-tool-names";
import * as runtimeIdentity from "@/services/agent-runtime/runtime-identity";
import { expect, test } from "@/test";
import { ApiError } from "@/types";
import { admitOpenappaRequest } from "./admission";
import { scrubOpenappaIngress } from "./ingress";

type AdmissionParams = Parameters<typeof admitOpenappaRequest>[0];
type Principal = AdmissionParams["principal"];

const NO_PRINCIPAL: Principal = {
  authenticatedUserId: undefined,
  authenticatedApp: undefined,
  virtualKeyId: undefined,
  passthroughVirtualKeyId: undefined,
  userId: undefined,
};

async function admission(params: {
  agent: { id: string; organizationId: string };
  principal: Partial<Principal>;
  headers?: Record<string, string>;
  overrides?: Partial<AdmissionParams>;
}): Promise<AdmissionParams> {
  const request = {
    headers: { ...params.headers },
    url: "/v1/openai/chat/completions",
    raw: { headers: {} },
  } as unknown as FastifyRequest;
  const body = { model: "gpt-test", messages: [] };
  const interactionType = "openai:chatCompletions";
  return {
    request,
    body,
    originalRequest: body,
    interactionType,
    agent: params.agent,
    principal: { ...NO_PRINCIPAL, ...params.principal },
    deployment: {
      active: true,
      observing: false,
      unsupportedClientAction: "block",
    },
    chatSource: undefined,
    externalAgentId: undefined,
    inProcessRequest: false,
    internalCall: false,
    installerSetupBypass: false,
    ingress: scrubOpenappaIngress({ request, body, interactionType }),
    toolIdentity: await resolveGatewayToolIdentity({
      organizationId: params.agent.organizationId,
      declarations: [],
      internalChat: false,
    }),
    ...params.overrides,
  };
}

function waiveClientRefusals() {
  config.openappa.breakTheGlassOverrides = { unapprovableBlockMode: "allow" };
}

function sessionOf(
  agent: { id: string; organizationId: string },
  callerId: string,
  sessionId = agent.id,
) {
  return {
    organization_id: agent.organizationId,
    caller_id: callerId,
    session_id: scopedSessionId(callerId, sessionId),
  };
}

test("a client-side refusal proceeds ungoverned only when blocked calls are allowed", async ({
  makeAgent,
  makeUser,
}) => {
  const agent = await makeAgent();
  const user = await makeUser();
  const unrecognizedClient = () =>
    admission({ agent, principal: { authenticatedUserId: user.id } });
  config.openappa.breakTheGlassOverrides = { unapprovableBlockMode: "refuse" };
  await expect(
    admitOpenappaRequest(await unrecognizedClient()),
  ).rejects.toMatchObject({ statusCode: 400 });

  waiveClientRefusals();
  expect(await admitOpenappaRequest(await unrecognizedClient())).toEqual({
    kind: "ungoverned",
  });
  expect(await isUnenforcedSession(sessionOf(agent, `user:${user.id}`))).toBe(
    true,
  );
});

test("a server or storage failure during admission propagates and the session stays enforced", async ({
  makeAgent,
}) => {
  const agent = await makeAgent();
  waiveClientRefusals();
  const virtualKeyId = randomUUID();
  for (const failure of [
    new ApiError(503, "runtime identity store unavailable"),
    new Error("connection reset"),
  ]) {
    const lookup = vi
      .spyOn(runtimeIdentity, "resolveRuntimeIdentityByVirtualKeys")
      .mockRejectedValue(failure);
    try {
      await expect(
        admitOpenappaRequest(
          await admission({ agent, principal: { virtualKeyId } }),
        ),
      ).rejects.toBe(failure);
    } finally {
      lookup.mockRestore();
    }
    expect(
      await isUnenforcedSession(
        sessionOf(agent, `virtual-key:${virtualKeyId}`),
      ),
    ).toBe(false);
  }
});

test("a platform authentication refusal is never waived", async ({
  makeAgent,
  makeUser,
}) => {
  const agent = await makeAgent();
  const user = await makeUser();
  waiveClientRefusals();
  const virtualKeyId = randomUUID();
  const workloadName = `workload-${randomUUID()}`;
  const actor = {
    organizationId: agent.organizationId,
    agentId: agent.id,
    actorKind: "user" as const,
    actorId: "someone-else",
    workloadName,
  };
  await expect(
    admitOpenappaRequest(
      await admission({
        agent,
        principal: { authenticatedUserId: user.id, virtualKeyId },
        overrides: {
          runtimeSnapshot: {
            organizationId: agent.organizationId,
            virtualKeyIds: [virtualKeyId],
            candidates: [
              {
                virtualKeyId,
                run: { ...actor, actorUserId: null, taskId: randomUUID() },
                workspace: { ...actor, id: randomUUID(), state: "active" },
              },
            ],
          },
        },
      }),
    ),
  ).rejects.toMatchObject({ statusCode: 401 });
  expect(await isUnenforcedSession(sessionOf(agent, `user:${user.id}`))).toBe(
    false,
  );
});

test("a Chat request for a conversation its user does not own is never waived", async ({
  makeAgent,
  makeUser,
}) => {
  const agent = await makeAgent();
  const user = await makeUser();
  waiveClientRefusals();
  const conversationId = randomUUID();
  await expect(
    admitOpenappaRequest(
      await admission({
        agent,
        principal: { userId: user.id },
        headers: { "x-appa-session-id": conversationId },
        overrides: { chatSource: "chat", inProcessRequest: true },
      }),
    ),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(
    await isUnenforcedSession(
      sessionOf(agent, `user:${user.id}`, conversationId),
    ),
  ).toBe(false);
});

test("admits and observes Grok Agent Runtime sessions under the bound workspace while still rejecting unbound Grok header mismatches", async ({
  makeAgent,
  makeUser,
}) => {
  const priorSecret = config.openappa.offerSigningSecret;
  config.openappa.offerSigningSecret = "grok-runtime-admission-secret-01234567";
  try {
    const agent = await makeAgent();
    const user = await makeUser();
    const grokHeaders = {
      "user-agent": "grok-shell/1.0.70 (linux; x86_64)",
      "x-grok-client-identifier": "grok-shell",
      "x-grok-client-mode": "interactive",
      "x-grok-session-id": randomUUID(),
    };
    const grokBody = {
      model: "grok-4",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
    };

    // Without a runtime binding, mismatched X-Appa-Session-ID vs X-Grok-Session-Id is rejected.
    config.openappa.breakTheGlassOverrides = {
      unapprovableBlockMode: "refuse",
    };
    await expect(
      admitOpenappaRequest(
        await admission({
          agent,
          principal: { authenticatedUserId: user.id },
          headers: { ...grokHeaders, "x-appa-session-id": "other-session" },
          overrides: { body: grokBody, originalRequest: grokBody },
        }),
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message:
        "Grok native and MCP session headers must identify the same session.",
    });

    // With a verified runtime workspace binding, both enforced and observing modes
    // accept X-Appa-Session-ID=<workloadName> alongside X-Grok-Session-Id=<uuid>.
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    const virtualKeyId = randomUUID();
    const workloadName = `archestra-agent-ws-${task.id.slice(0, 8)}`;
    const workspace = await AgentWorkspaceModel.create({
      organizationId: agent.organizationId,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      backend: "kubernetes",
      runtimeScope: "test",
      workloadName,
      state: "active",
      activeTaskId: task.id,
      lastTaskId: task.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const run = await AgentRunModel.create({
      organizationId: agent.organizationId,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      workloadName,
      backend: "kubernetes",
      runtimeScope: "test",
      virtualApiKeyId: null,
    });
    const binding = runtimeIdentity.issueRuntimeBinding({
      secret: config.openappa.offerSigningSecret,
      organizationId: agent.organizationId,
      workspaceId: workspace.id,
      workloadName,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      expiresAt: Date.now() + 600_000,
    });
    if (!binding) throw new Error("Expected runtime binding token");
    const runtimeSnapshot = {
      organizationId: agent.organizationId,
      virtualKeyIds: [virtualKeyId],
      candidates: [
        {
          virtualKeyId,
          run,
          workspace,
        },
      ],
    };
    const runtimeHeaders = {
      ...grokHeaders,
      "x-appa-session-id": workloadName,
      "x-archestra-runtime-binding": binding,
    };

    const governed = await admitOpenappaRequest(
      await admission({
        agent,
        principal: { authenticatedUserId: user.id, virtualKeyId },
        headers: runtimeHeaders,
        overrides: {
          body: grokBody,
          originalRequest: grokBody,
          runtimeSnapshot,
        },
      }),
    );
    expect(governed).toMatchObject({
      kind: "governed",
      session: {
        organization_id: agent.organizationId,
        caller_id: `user:${user.id}`,
        session_id: `user:${user.id}|${workloadName}`,
      },
      identity: {
        sessionId: workloadName,
        provenance: "appa-header",
      },
      facts: {
        agentRuntimeRun: true,
        runtimeSessionId: `user:${user.id}|${workloadName}`,
      },
    });

    const observed = await admitOpenappaRequest(
      await admission({
        agent,
        principal: { authenticatedUserId: user.id, virtualKeyId },
        headers: runtimeHeaders,
        overrides: {
          body: grokBody,
          originalRequest: grokBody,
          runtimeSnapshot,
          deployment: {
            active: false,
            observing: true,
            unsupportedClientAction: "bypass",
          },
        },
      }),
    );
    expect(observed).toMatchObject({
      kind: "observed",
      trustedContext: {
        session: {
          organization_id: agent.organizationId,
          caller_id: `user:${user.id}`,
          session_id: `user:${user.id}|${workloadName}`,
        },
        agentRuntimeRun: true,
      },
    });
  } finally {
    config.openappa.offerSigningSecret = priorSecret;
  }
});
