import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import AppaProxySessionModel from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import { expect, test } from "@/test";
import {
  admitNativeChildCompletion,
  attachNativeChild,
  extractNativeChildRequest,
  parseNativeChildCompletionEnvelope,
  prepareNativeChildSpawnPublication,
  resolveNativeChildSpawnBinding,
} from "./appa-native-child-correlation";

beforeEach(() => {
  config.llmProxy.appaHook = {
    url: "http://native-child.test",
    timeoutMs: 100,
    sessionHmacSecret: "native-child-session-secret".repeat(3),
  };
});

describe("native child correlation", () => {
  test("resolves only an issued task alias, then lets the hook consume it once", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({ makeAgent });

    await expect(
      resolveNativeChildSpawnBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childTaskPath: "/root/not-issued",
      }),
    ).rejects.toThrow("unique issued spawn alias");
    const resolved = await resolveNativeChildSpawnBinding({
      ownerScopeHash: fixture.scope.ownerScopeHash,
      profileId: fixture.scope.profileId,
      parentClientSessionId: fixture.parentClientSessionId,
      childTaskPath: fixture.child.childTaskPath,
    });
    expect(resolved).toEqual({
      spawnBinding: fixture.spawnBinding,
      logicalTaskPath: "/tasks/root/reader",
    });
    const [beforeAcquire] = await db
      .select({
        childThreadId: schema.appaProxyWireAliasesTable.childThreadId,
        spawnBindingConsumedAt:
          schema.appaProxyCallsTable.spawnBindingConsumedAt,
      })
      .from(schema.appaProxyWireAliasesTable)
      .innerJoin(
        schema.appaProxyCallsTable,
        eq(
          schema.appaProxyWireAliasesTable.sourceCallId,
          schema.appaProxyCallsTable.callId,
        ),
      )
      .where(eq(schema.appaProxyWireAliasesTable.id, fixture.aliasId));
    expect(beforeAcquire).toEqual({
      childThreadId: null,
      spawnBindingConsumedAt: null,
    });

    await consumeChildSpawn(fixture);
    await expect(
      resolveNativeChildSpawnBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).rejects.toThrow("unconsumed runtime spawn binding");

    await attachNativeChild({
      ...fixture.scope,
      parentClientSessionId: fixture.parentClientSessionId,
      spawnBinding: fixture.spawnBinding,
      ...fixture.child,
    });
    const [stored] = await db
      .select({
        childThreadId: schema.appaProxyWireAliasesTable.childThreadId,
        consumedAt: schema.appaProxyWireAliasesTable.consumedAt,
      })
      .from(schema.appaProxyWireAliasesTable)
      .where(eq(schema.appaProxyWireAliasesTable.id, fixture.aliasId));
    expect(stored).toEqual({
      childThreadId: fixture.child.childClientSessionId,
      consumedAt: null,
    });

    await expect(
      attachNativeChild({
        ...fixture.scope,
        parentClientSessionId: fixture.parentClientSessionId,
        spawnBinding: fixture.spawnBinding,
        ...fixture.child,
      }),
    ).rejects.toThrow("consumed runtime spawn binding");
  });

  test("rejects cross-profile aliases and resolves nested stock task paths", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({
      makeAgent,
      clientParentTaskPath: "/root/reader__proxy_7c91",
      logicalParentTaskPath: "/tasks/root/reader",
      originalProviderTaskName: "analyst",
      wireTaskName: "analyst__proxy_9f31",
    });
    const anotherProfile = await makeAgent();

    await expect(
      resolveNativeChildSpawnBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: anotherProfile.id,
        parentClientSessionId: fixture.parentClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).rejects.toThrow("outside the owned profile lane");
    await expect(
      resolveNativeChildSpawnBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).resolves.toEqual({
      spawnBinding: fixture.spawnBinding,
      logicalTaskPath: "/tasks/root/reader/analyst",
    });
  });

  test("extracts stock child metadata and admits one opaque completion", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({ makeAgent });
    expect(
      extractNativeChildRequest({
        headers: {
          "x-codex-parent-thread-id": fixture.parentClientSessionId,
          "thread-id": fixture.child.childClientSessionId,
          "x-codex-turn-metadata": JSON.stringify({
            parent_thread_id: fixture.parentClientSessionId,
            thread_id: fixture.child.childClientSessionId,
            agent_name: fixture.child.childTaskPath,
          }),
        },
        request: { client_metadata: {} },
      }),
    ).toEqual({
      parentClientSessionId: fixture.parentClientSessionId,
      childClientSessionId: fixture.child.childClientSessionId,
      childTaskPath: fixture.child.childTaskPath,
    });
    expect(
      extractNativeChildRequest({
        headers: {
          "x-codex-parent-thread-id": fixture.parentClientSessionId,
          "thread-id": fixture.child.childClientSessionId,
          "x-codex-turn-metadata": JSON.stringify({
            parent_thread_id: "different-parent",
            thread_id: fixture.child.childClientSessionId,
            agent_name: fixture.child.childTaskPath,
          }),
        },
        request: { client_metadata: {} },
      }),
    ).toBeNull();
    await consumeChildSpawn(fixture);
    await attachNativeChild({
      ...fixture.scope,
      parentClientSessionId: fixture.parentClientSessionId,
      spawnBinding: fixture.spawnBinding,
      ...fixture.child,
    });
    const privateBody = "SYNTHETIC_PRIVATE_NATIVE_CHILD_COMPLETION";
    const completion = [
      "Message Type: FINAL_ANSWER",
      "Task name: /root",
      "Sender: /root/reader__proxy_7c91",
      "Payload:",
      privateBody,
    ].join("\n");

    expect(parseNativeChildCompletionEnvelope(completion)).toEqual({
      clientParentTaskPath: "/root",
      clientTaskPath: "/root/reader__proxy_7c91",
    });
    await expect(
      admitNativeChildCompletion({
        ...fixture.scope,
        content: "Message Type: FINAL_ANSWER\nTask name: /root",
      }),
    ).rejects.toThrow("completion envelope is invalid");
    const [beforeAdmission] = await db
      .select({ consumedAt: schema.appaProxyWireAliasesTable.consumedAt })
      .from(schema.appaProxyWireAliasesTable)
      .where(eq(schema.appaProxyWireAliasesTable.id, fixture.aliasId));
    expect(beforeAdmission?.consumedAt).toBeNull();
    await admitNativeChildCompletion({
      ...fixture.scope,
      content: completion,
    });
    const [stored] = await db
      .select({
        consumedAt: schema.appaProxyWireAliasesTable.consumedAt,
        metadataCiphertext: schema.appaProxyWireAliasesTable.metadataCiphertext,
      })
      .from(schema.appaProxyWireAliasesTable)
      .where(eq(schema.appaProxyWireAliasesTable.id, fixture.aliasId));
    expect(stored?.consumedAt).toBeInstanceOf(Date);
    expect(stored?.metadataCiphertext).not.toContain(privateBody);

    await expect(
      admitNativeChildCompletion({
        ...fixture.scope,
        content: completion,
      }),
    ).rejects.toThrow("attached task alias");
  });
});

async function createPublishedChildFixture(params: {
  makeAgent: () => Promise<{ id: string }>;
  clientParentTaskPath?: string;
  logicalParentTaskPath?: string;
  originalProviderTaskName?: string;
  wireTaskName?: string;
}) {
  const agent = await params.makeAgent();
  const ownerScopeHash = `native-child-owner-${randomUUID()}`;
  const parentClientSessionId = `native-parent-${randomUUID()}`;
  const childClientSessionId = `native-child-${randomUUID()}`;
  const sourceCallId = `call-spawn-${randomUUID()}`;
  const spawnBinding = `binding-${randomUUID()}`;
  const clientParentTaskPath = params.clientParentTaskPath ?? "/root";
  const logicalParentTaskPath = params.logicalParentTaskPath ?? "/tasks/root";
  const originalProviderTaskName = params.originalProviderTaskName ?? "reader";
  const wireTaskName = params.wireTaskName ?? "reader__proxy_7c91";
  const childTaskPath = `${clientParentTaskPath}/${wireTaskName}`;
  const parent = await AppaProxySessionModel.enterTurn({
    profileId: agent.id,
    ownerScopeHash,
    clientSessionId: parentClientSessionId,
    rootId: `native-root-${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 10,
  });
  const scope = {
    sessionId: parent.session.id,
    ownerScopeHash,
    profileId: agent.id,
  };
  await AppaProxySessionModel.createOutboundIntent({
    turn: parent,
    maxCallsPerSession: 10,
    calls: [
      {
        callId: sourceCallId,
        emittedName: "collaboration.spawn_agent",
        emittedArguments:
          '{"task_name":"reader__proxy_7c91","message":"ciphertext"}',
        emittedArgumentsCanonical:
          '{"message":"ciphertext","task_name":"reader__proxy_7c91"}',
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
    requestHash: "native-child-request",
    idempotencyKey: `native-child-response:${parent.turnId}`,
    payload: { output: [] },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const publication = prepareNativeChildSpawnPublication({
    taskAlias: {
      logicalTaskPath: `${logicalParentTaskPath}/${originalProviderTaskName}`,
      clientTaskPath: childTaskPath,
      wireTaskName,
    },
    position: 0,
    clientParentTaskPath,
    logicalParentTaskPath,
    originalProviderTaskName,
    approvedCall: { callId: sourceCallId, spawnBinding },
  });
  expect(publication.rewrittenTaskName).toBe(wireTaskName);
  const [alias] = await AppaProxyWireModel.addAliases({
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
        callId: sourceCallId,
        dispatchId: `dispatch-${sourceCallId}`,
        spawnBinding,
      },
    ],
  });
  await AppaProxySessionModel.releaseTurn(parent);
  return {
    scope,
    aliasId: alias.id,
    spawnBinding,
    parentClientSessionId,
    child: {
      childClientSessionId,
      childTaskPath,
    },
  };
}

async function consumeChildSpawn(
  fixture: Awaited<ReturnType<typeof createPublishedChildFixture>>,
) {
  await AppaProxySessionModel.enterTurn({
    profileId: fixture.scope.profileId,
    ownerScopeHash: fixture.scope.ownerScopeHash,
    clientSessionId: fixture.child.childClientSessionId,
    parentClientSessionId: fixture.parentClientSessionId,
    spawnBinding: fixture.spawnBinding,
    rootId: `ignored-child-root-${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 10,
  });
}
