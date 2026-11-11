import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { vi } from "vitest";
import config from "@/config";
import { scopedSessionId } from "@/openappa/actor";
import { isUnenforcedSession } from "@/openappa/unenforced";
import { resolveGatewayToolIdentity } from "@/routes/proxy/utils/gateway-tool-names";
import * as runtimeIdentity from "@/services/agent-runtime/runtime-identity";
import { afterEach, expect, test } from "@/test";
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

const configuredSoftBlockMode = config.openappa.softBlockMode;
afterEach(() => {
  config.openappa.softBlockMode = configuredSoftBlockMode;
});

function waiveClientRefusals() {
  config.openappa.softBlockMode = "allow";
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
  config.openappa.softBlockMode = "refuse";
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
  const lookup = vi
    .spyOn(runtimeIdentity, "resolveRuntimeIdentityByVirtualKeys")
    .mockResolvedValue({
      status: "bound",
      identity: {
        principal: workloadName,
        workspaceId: randomUUID(),
        workloadName,
        organizationId: agent.organizationId,
        agentId: agent.id,
        actorKind: "user",
        actorId: "someone-else",
        actorUserId: null,
        taskId: randomUUID(),
      },
    });
  try {
    await expect(
      admitOpenappaRequest(
        await admission({
          agent,
          principal: { authenticatedUserId: user.id, virtualKeyId },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  } finally {
    lookup.mockRestore();
  }
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
