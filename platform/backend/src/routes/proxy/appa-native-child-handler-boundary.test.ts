import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import AppaProxySessionModel from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import {
  attachNativeChild,
  extractNativeChildRequest,
  prepareNativeChildSpawnPublication,
  resolveNativeChildSpawnBinding,
} from "@/services/appa-native-child-correlation";
import { expect, test } from "@/test";

beforeEach(() => {
  config.llmProxy.appaHook = {
    url: "http://native-child-boundary.test",
    timeoutMs: 100,
    sessionHmacSecret: "native-child-boundary-secret".repeat(3),
  };
});

test("attaches a stock native child without a client-provided spawn binding", async ({
  makeAgent,
}) => {
  const agent = await makeAgent();
  const ownerScopeHash = `native-handler-owner-${randomUUID()}`;
  const parentClientSessionId = `native-handler-parent-${randomUUID()}`;
  const childClientSessionId = `native-handler-child-${randomUUID()}`;
  const callId = `call-spawn-${randomUUID()}`;
  const spawnBinding = `binding-${randomUUID()}`;
  const parent = await AppaProxySessionModel.enterTurn({
    profileId: agent.id,
    ownerScopeHash,
    clientSessionId: parentClientSessionId,
    rootId: `native-handler-root-${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 10,
  });
  await AppaProxySessionModel.createOutboundIntent({
    turn: parent,
    maxCallsPerSession: 10,
    calls: [
      {
        callId,
        emittedName: "collaboration.spawn_agent",
        emittedArguments: '{"task_name":"reader","message":"opaque"}',
        emittedArgumentsCanonical: '{"message":"opaque","task_name":"reader"}',
        appaTargetName: "collaboration.spawn_agent",
        appaTargetArguments: {},
      },
    ],
  });
  const frame = await AppaProxyWireModel.createFrame({
    sessionId: parent.session.id,
    ownerScopeHash,
    turnId: parent.turnId,
    kind: "model_response",
    protocol: "codex-native-response/v1",
    requestHash: "native-handler-request",
    idempotencyKey: `native-handler-response:${parent.turnId}`,
    payload: { output: [] },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const publication = prepareNativeChildSpawnPublication({
    taskAlias: {
      logicalTaskPath: "/tasks/root/reader",
      clientTaskPath: "/root/reader__proxy_abc123",
      wireTaskName: "reader__proxy_abc123",
    },
    position: 0,
    clientParentTaskPath: "/root",
    logicalParentTaskPath: "/tasks/root",
    originalProviderTaskName: "reader",
    approvedCall: { callId, spawnBinding },
  });
  await AppaProxyWireModel.addAliases({
    sessionId: parent.session.id,
    ownerScopeHash,
    frameId: frame.id,
    aliases: [publication.alias],
  });
  await AppaProxyWireModel.markReady({
    sessionId: parent.session.id,
    ownerScopeHash,
    frameId: frame.id,
  });
  await AppaProxyWireModel.markIssued({
    sessionId: parent.session.id,
    ownerScopeHash,
    frameId: frame.id,
  });
  await AppaProxySessionModel.approveOutboundCallBatch({
    turn: parent,
    calls: [
      {
        callId,
        dispatchId: `dispatch-${callId}`,
        spawnBinding,
      },
    ],
  });
  await AppaProxySessionModel.releaseTurn(parent);

  const child = extractNativeChildRequest({
    headers: {
      "x-codex-parent-thread-id": parentClientSessionId,
      "thread-id": childClientSessionId,
      "x-codex-turn-metadata": JSON.stringify({
        parent_thread_id: parentClientSessionId,
        thread_id: childClientSessionId,
        agent_name: "/root/reader__proxy_abc123",
      }),
    },
    request: { client_metadata: {} },
  });
  expect(child).toEqual({
    parentClientSessionId,
    childClientSessionId,
    childTaskPath: "/root/reader__proxy_abc123",
  });
  if (!child) throw new Error("expected stock child metadata");
  const resolved = await resolveNativeChildSpawnBinding({
    ownerScopeHash,
    profileId: agent.id,
    parentClientSessionId: child.parentClientSessionId,
    childTaskPath: child.childTaskPath,
  });
  expect(resolved.logicalTaskPath).toBe("/tasks/root/reader");

  // Mirrors AppaProxyHookSession.acquire: only the server-resolved capability is consumed.
  await AppaProxySessionModel.enterTurn({
    profileId: agent.id,
    ownerScopeHash,
    clientSessionId: child.childClientSessionId,
    parentClientSessionId: child.parentClientSessionId,
    spawnBinding: resolved.spawnBinding,
    rootId: `ignored-child-root-${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 10,
  });
  await attachNativeChild({
    ownerScopeHash,
    profileId: agent.id,
    parentClientSessionId: child.parentClientSessionId,
    childClientSessionId: child.childClientSessionId,
    childTaskPath: child.childTaskPath,
    spawnBinding: resolved.spawnBinding,
  });
  const [alias] = await db
    .select({ childThreadId: schema.appaProxyWireAliasesTable.childThreadId })
    .from(schema.appaProxyWireAliasesTable)
    .where(eq(schema.appaProxyWireAliasesTable.sourceCallId, callId));
  expect(alias?.childThreadId).toBe(childClientSessionId);
});
