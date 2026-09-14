import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { beforeEach, describe } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import AppaNativeChildCorrelationModel from "@/models/appa-native-child-correlation";
import AppaProxySessionModel from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import { AppaProxyHookSession } from "@/routes/proxy/appa-proxy-hook";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  admitNativeChildCompletion,
  attachNativeChild,
  extractNativeChildRequest,
  parseNativeChildCompletionEnvelope,
  prepareNativeChildSpawnPublication,
  resolveNativeChildBinding,
} from "./appa-native-child-correlation";

beforeEach(() => {
  config.llmProxy.appaHook = {
    url: "http://native-child.test",
    timeoutMs: 100,
    sessionHmacSecret: "native-child-session-secret".repeat(3),
  };
});

describe("native child correlation", () => {
  const server = useMswServer();
  test("attaches an acquired child before its first acknowledged runtime start", async ({
    makeAgent,
  }) => {
    const runtimeConfig = {
      url: "http://native-child.test",
      timeoutMs: 1000,
      sessionHmacSecret: "native-child-session-secret".repeat(3),
      runtimeToken: "native-child-runtime-token",
    };
    config.llmProxy.appaHook = runtimeConfig;
    const fixture = await createPublishedChildFixture({ makeAgent });
    const events: string[] = [];
    server.use(
      http.get(`${runtimeConfig.url}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: false,
          child_workflows: true,
          child_actor_targeting: true,
          sanitized_results: true,
        }),
      ),
      http.post(`${runtimeConfig.url}/proxy/v1/events`, async ({ request }) => {
        const body = await request.text();
        const envelope = JSON.parse(body);
        events.push(envelope.event.event);
        expect(envelope.event.root_id).toBe(fixture.rootId);
        expect(envelope.event.child_id).toBe(
          fixture.child.childClientSessionId,
        );
        if (envelope.event.event === "child_start") {
          expect(envelope.event.spawn_binding).toBe(fixture.spawnBinding);
        }
        return HttpResponse.json({
          protocol_version: 1,
          event_id: envelope.event_id,
          request_sha256: createHash("sha256").update(body).digest("hex"),
          decision: { decision: "ack" },
        });
      }),
    );
    const acquisition = {
      config: runtimeConfig,
      ownerScopeHash: fixture.scope.ownerScopeHash,
      profileId: fixture.scope.profileId,
      clientSessionId: fixture.child.childClientSessionId,
      parentClientSessionId: fixture.parentClientSessionId,
      spawnBinding: fixture.spawnBinding,
      toolResults: [],
    };
    let session = await AppaProxyHookSession.acquire(acquisition);
    const attachment = {
      ...fixture.scope,
      parentClientSessionId: fixture.parentClientSessionId,
      spawnBinding: fixture.spawnBinding,
      ...fixture.child,
    };
    await attachNativeChild(attachment);
    expect(events).toEqual([]);
    const [before] = await db
      .select()
      .from(schema.appaProxySessionsTable)
      .where(
        eq(
          schema.appaProxySessionsTable.id,
          session.getNativeWireScope().sessionId,
        ),
      );
    expect(before).toMatchObject({ state: "in_turn", childStartedAt: null });
    await session.releaseWithoutPrompt();
    await expect(attachNativeChild(attachment)).rejects.toThrow(
      "not started its acquired turn",
    );
    session = await AppaProxyHookSession.acquire(acquisition);
    await attachNativeChild(attachment);
    await session.sendPrompt({ message: "synthetic child task" });
    expect(events).toEqual(["child_start", "prompt"]);
    const [after] = await db
      .select()
      .from(schema.appaProxySessionsTable)
      .where(eq(schema.appaProxySessionsTable.id, before.id));
    expect(after.childStartedAt).toBeInstanceOf(Date);
    await session.finish({ childReturn: "synthetic child return" });
    expect(events.at(-1)).toBe("child_end");
    await expect(attachNativeChild(attachment)).resolves.toBeUndefined();
  });

  test("resolves only an issued task alias, then lets the hook consume it once", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({ makeAgent });

    await expect(
      resolveNativeChildBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: "/root/not-issued",
      }),
    ).rejects.toThrow("bound issued spawn alias");
    const resolved = await resolveNativeChildBinding({
      ownerScopeHash: fixture.scope.ownerScopeHash,
      profileId: fixture.scope.profileId,
      parentClientSessionId: fixture.parentClientSessionId,
      childClientSessionId: fixture.child.childClientSessionId,
      childTaskPath: fixture.child.childTaskPath,
    });
    expect(resolved).toEqual({
      spawnBinding: fixture.spawnBinding,
      logicalTaskPath: "/tasks/root/reader",
      needsAttachment: true,
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
      childThreadId: fixture.child.childClientSessionId,
      spawnBindingConsumedAt: null,
    });

    const childTurn = await consumeChildSpawn(fixture);
    await expect(
      AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
        parentSessionId: fixture.scope.sessionId,
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        sourceCallId: fixture.sourceCallId,
        childClientSessionId: fixture.child.childClientSessionId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveNativeChildBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).resolves.toEqual({
      logicalTaskPath: "/tasks/root/reader",
      needsAttachment: false,
    });

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
    expect(childTurn.session.rootId).toBe(fixture.rootId);

    await AppaProxySessionModel.releaseTurn(childTurn);
    await expect(
      resolveNativeChildBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).resolves.toEqual({
      logicalTaskPath: "/tasks/root/reader",
      needsAttachment: false,
    });
    await expect(
      resolveNativeChildBinding({
        ownerScopeHash: `${fixture.scope.ownerScopeHash}-other-owner`,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).rejects.toThrow("outside the owned profile lane");
    await expect(
      resolveNativeChildBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: "wrong-native-parent",
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).rejects.toThrow("outside the owned profile lane");
    await expect(
      resolveNativeChildBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: "replayed-native-child",
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).rejects.toThrow("bound issued spawn alias");

    await expect(
      attachNativeChild({
        ...fixture.scope,
        parentClientSessionId: fixture.parentClientSessionId,
        spawnBinding: fixture.spawnBinding,
        ...fixture.child,
      }),
    ).resolves.toBeUndefined();
  });

  test("projects only the bound child identity from the issued alias", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({ makeAgent });

    await expect(
      AppaNativeChildCorrelationModel.projectBoundSpawnControl({
        parentSessionId: fixture.scope.sessionId,
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        sourceCallId: fixture.sourceCallId,
      }),
    ).resolves.toEqual({ agentId: fixture.child.childClientSessionId });
    await expect(
      AppaNativeChildCorrelationModel.projectBoundSpawnControl({
        parentSessionId: fixture.scope.sessionId,
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        sourceCallId: `other-${fixture.sourceCallId}`,
      }),
    ).resolves.toBeNull();
  });

  test("resolves an issued child alias after Codex admits the spawn result", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({ makeAgent });
    await db
      .update(schema.appaProxyCallsTable)
      .set({ state: "result_admitted" })
      .where(eq(schema.appaProxyCallsTable.callId, fixture.sourceCallId));

    await expect(
      resolveNativeChildBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).resolves.toEqual({
      spawnBinding: fixture.spawnBinding,
      logicalTaskPath: "/tasks/root/reader",
      needsAttachment: true,
    });
    const childTurn = await consumeChildSpawn(fixture);
    await expect(
      attachNativeChild({
        ...fixture.scope,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: "/root",
        spawnBinding: fixture.spawnBinding,
      }),
    ).resolves.toBeUndefined();
    await AppaProxySessionModel.releaseTurn(childTurn);
  });

  test("rejects continuation and result replay when the child's parent call differs", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({ makeAgent });
    const childTurn = await consumeChildSpawn(fixture);
    await AppaProxySessionModel.releaseTurn(childTurn);
    await db
      .update(schema.appaProxySessionsTable)
      .set({ parentCallId: "different-parent-spawn" })
      .where(eq(schema.appaProxySessionsTable.id, childTurn.session.id));

    await expect(
      resolveNativeChildBinding({
        ...fixture.scope,
        parentClientSessionId: fixture.parentClientSessionId,
        ...fixture.child,
      }),
    ).rejects.toThrow("no unconsumed runtime spawn binding");
    await expect(
      AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
        ...fixture.scope,
        parentSessionId: fixture.scope.sessionId,
        sourceCallId: fixture.sourceCallId,
        childClientSessionId: fixture.child.childClientSessionId,
      }),
    ).rejects.toThrow("outside the parent root");
  });

  test("requires a parent-result binding and accepts parent task metadata for that exact child thread", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({
      makeAgent,
      bindSpawnResult: false,
    });

    await expect(
      resolveNativeChildBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).rejects.toThrow("bound issued spawn alias");

    await AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
      parentSessionId: fixture.scope.sessionId,
      ownerScopeHash: fixture.scope.ownerScopeHash,
      profileId: fixture.scope.profileId,
      sourceCallId: fixture.sourceCallId,
      childClientSessionId: fixture.child.childClientSessionId,
    });

    await expect(
      resolveNativeChildBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: "/root",
      }),
    ).resolves.toEqual({
      spawnBinding: fixture.spawnBinding,
      logicalTaskPath: "/tasks/root/reader",
      needsAttachment: true,
    });
  });

  test("binds each parent spawn result exactly once without mutating source fields", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({ makeAgent });
    const [before] = await db
      .select({
        emittedArguments: schema.appaProxyCallsTable.emittedArguments,
        emittedArgumentsCanonical:
          schema.appaProxyCallsTable.emittedArgumentsCanonical,
        sourceCallId: schema.appaProxyWireAliasesTable.sourceCallId,
        metadataCiphertext: schema.appaProxyWireAliasesTable.metadataCiphertext,
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

    await expect(
      AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
        parentSessionId: fixture.scope.sessionId,
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        sourceCallId: fixture.sourceCallId,
        childClientSessionId: fixture.child.childClientSessionId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      Promise.all([
        AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
          parentSessionId: fixture.scope.sessionId,
          ownerScopeHash: fixture.scope.ownerScopeHash,
          profileId: fixture.scope.profileId,
          sourceCallId: fixture.sourceCallId,
          childClientSessionId: fixture.child.childClientSessionId,
        }),
        AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
          parentSessionId: fixture.scope.sessionId,
          ownerScopeHash: fixture.scope.ownerScopeHash,
          profileId: fixture.scope.profileId,
          sourceCallId: fixture.sourceCallId,
          childClientSessionId: fixture.child.childClientSessionId,
        }),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(
      AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
        parentSessionId: fixture.scope.sessionId,
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        sourceCallId: fixture.sourceCallId,
        childClientSessionId: `conflicting-child-${randomUUID()}`,
      }),
    ).rejects.toThrow("conflicts with an attached child thread");
    await expect(
      AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
        parentSessionId: fixture.scope.sessionId,
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        sourceCallId: `forged-call-${randomUUID()}`,
        childClientSessionId: fixture.child.childClientSessionId,
      }),
    ).rejects.toThrow("unique issued task alias");
    await expect(
      AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
        parentSessionId: fixture.scope.sessionId,
        ownerScopeHash: `other-owner-${randomUUID()}`,
        profileId: fixture.scope.profileId,
        sourceCallId: fixture.sourceCallId,
        childClientSessionId: fixture.child.childClientSessionId,
      }),
    ).rejects.toThrow("outside the owned profile lane");
    const [after] = await db
      .select({
        emittedArguments: schema.appaProxyCallsTable.emittedArguments,
        emittedArgumentsCanonical:
          schema.appaProxyCallsTable.emittedArgumentsCanonical,
        sourceCallId: schema.appaProxyWireAliasesTable.sourceCallId,
        metadataCiphertext: schema.appaProxyWireAliasesTable.metadataCiphertext,
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
    expect(after).toEqual(before);
  });

  test("keeps two issued spawns bound to distinct child threads and rejects a duplicate agent", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({ makeAgent });
    const secondCallId = `call-spawn-${randomUUID()}`;
    const secondChildId = `native-child-${randomUUID()}`;
    const [originalAlias] = await db
      .select()
      .from(schema.appaProxyWireAliasesTable)
      .where(eq(schema.appaProxyWireAliasesTable.id, fixture.aliasId));
    if (!originalAlias) throw new Error("missing native child alias");
    await db.insert(schema.appaProxyCallsTable).values({
      sessionId: fixture.scope.sessionId,
      callId: secondCallId,
      emittedName: "collaboration.spawn_agent",
      emittedArguments: '{"task_name":"analyst","message":"ciphertext"}',
      emittedArgumentsCanonical:
        '{"message":"ciphertext","task_name":"analyst"}',
      appaTargetName: "collaboration.spawn_agent",
      appaTargetArguments: {},
      dispatchId: `dispatch-${secondCallId}`,
      spawnBinding: `binding-${randomUUID()}`,
      state: "open",
    });
    await db.insert(schema.appaProxyWireAliasesTable).values({
      id: randomUUID(),
      sessionId: fixture.scope.sessionId,
      frameId: originalAlias.frameId,
      kind: "task",
      position: originalAlias.position + 1,
      wireId: `analyst__proxy_${randomUUID()}`,
      logicalId: "/tasks/root/analyst",
      sourceCallId: secondCallId,
      metadataCiphertext: originalAlias.metadataCiphertext,
      metadataBytes: originalAlias.metadataBytes,
    });

    await AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
      parentSessionId: fixture.scope.sessionId,
      ownerScopeHash: fixture.scope.ownerScopeHash,
      profileId: fixture.scope.profileId,
      sourceCallId: secondCallId,
      childClientSessionId: secondChildId,
    });
    await expect(
      AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
        parentSessionId: fixture.scope.sessionId,
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        sourceCallId: secondCallId,
        childClientSessionId: fixture.child.childClientSessionId,
      }),
    ).rejects.toThrow("already bound to a different call");
    const stored = await db
      .select({
        sourceCallId: schema.appaProxyWireAliasesTable.sourceCallId,
        childThreadId: schema.appaProxyWireAliasesTable.childThreadId,
      })
      .from(schema.appaProxyWireAliasesTable)
      .where(
        eq(schema.appaProxyWireAliasesTable.sessionId, fixture.scope.sessionId),
      );
    expect(stored).toEqual(
      expect.arrayContaining([
        {
          sourceCallId: fixture.sourceCallId,
          childThreadId: fixture.child.childClientSessionId,
        },
        { sourceCallId: secondCallId, childThreadId: secondChildId },
      ]),
    );
  });

  test("rejects binding a result to an existing thread outside the parent root", async ({
    makeAgent,
  }) => {
    const fixture = await createPublishedChildFixture({
      makeAgent,
      bindSpawnResult: false,
    });
    const unrelated = await AppaProxySessionModel.enterTurn({
      profileId: fixture.scope.profileId,
      ownerScopeHash: fixture.scope.ownerScopeHash,
      clientSessionId: `native-unrelated-${randomUUID()}`,
      rootId: `native-unrelated-root-${randomUUID()}`,
      turnId: randomUUID(),
      maxSessionsPerOwner: 10,
    });
    await expect(
      AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
        parentSessionId: fixture.scope.sessionId,
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        sourceCallId: fixture.sourceCallId,
        childClientSessionId: unrelated.session.clientSessionId,
      }),
    ).rejects.toThrow("outside the parent root");
    await AppaProxySessionModel.releaseTurn(unrelated);
  });

  test("admits every canonical Codex spawn spelling only from an active issued frame", async ({
    makeAgent,
  }) => {
    for (const emittedName of [
      "multi_agent_v1.spawn_agent",
      "agents.spawn_agent",
      "collaboration.spawn_agent",
    ]) {
      const fixture = await createPublishedChildFixture({
        makeAgent,
        emittedName,
      });
      const issued =
        await AppaNativeChildCorrelationModel.listIssuedSpawnSourceCallIds({
          parentSessionId: fixture.scope.sessionId,
          ownerScopeHash: fixture.scope.ownerScopeHash,
          profileId: fixture.scope.profileId,
        });
      expect(issued).toEqual(new Set([fixture.sourceCallId]));
      await expect(
        resolveNativeChildBinding({
          ownerScopeHash: fixture.scope.ownerScopeHash,
          profileId: fixture.scope.profileId,
          parentClientSessionId: fixture.parentClientSessionId,
          childClientSessionId: fixture.child.childClientSessionId,
          childTaskPath: fixture.child.childTaskPath,
        }),
      ).resolves.toMatchObject({ needsAttachment: true });
    }
    const expired = await createPublishedChildFixture({
      makeAgent,
      bindSpawnResult: false,
    });
    await db
      .update(schema.appaProxyWireFramesTable)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(
        eq(schema.appaProxyWireFramesTable.sessionId, expired.scope.sessionId),
      );
    await expect(
      AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
        parentSessionId: expired.scope.sessionId,
        ownerScopeHash: expired.scope.ownerScopeHash,
        profileId: expired.scope.profileId,
        sourceCallId: expired.sourceCallId,
        childClientSessionId: expired.child.childClientSessionId,
      }),
    ).rejects.toThrow("unique issued task alias");
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
      resolveNativeChildBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: anotherProfile.id,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).rejects.toThrow("outside the owned profile lane");
    await expect(
      resolveNativeChildBinding({
        ownerScopeHash: fixture.scope.ownerScopeHash,
        profileId: fixture.scope.profileId,
        parentClientSessionId: fixture.parentClientSessionId,
        childClientSessionId: fixture.child.childClientSessionId,
        childTaskPath: fixture.child.childTaskPath,
      }),
    ).resolves.toEqual({
      spawnBinding: fixture.spawnBinding,
      logicalTaskPath: "/tasks/root/reader/analyst",
      needsAttachment: true,
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
  bindSpawnResult?: boolean;
  emittedName?: string;
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
  const emittedName = params.emittedName ?? "collaboration.spawn_agent";
  const childTaskPath = `${clientParentTaskPath}/${wireTaskName}`;
  const rootId = `native-root-${randomUUID()}`;
  const parent = await AppaProxySessionModel.enterTurn({
    profileId: agent.id,
    ownerScopeHash,
    clientSessionId: parentClientSessionId,
    rootId,
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
        emittedName,
        emittedArguments: `{"task_name":"${originalProviderTaskName}","message":"ciphertext"}`,
        emittedArgumentsCanonical: `{"message":"ciphertext","task_name":"${originalProviderTaskName}"}`,
        appaTargetName: emittedName,
        appaTargetArguments: {},
      },
    ],
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
  const frame = await AppaProxyWireModel.createFrame({
    sessionId: parent.session.id,
    ownerScopeHash,
    turnId: parent.turnId,
    kind: "model_response",
    protocol: "codex-native-response/v1",
    requestHash: "native-child-request",
    idempotencyKey: `native-child-response:${parent.turnId}`,
    payload: {
      committedCalls: [
        {
          id: sourceCallId,
          name: emittedName,
          arguments: `{"task_name":"${originalProviderTaskName}","message":"ciphertext"}`,
        },
      ],
    },
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
    nativeChildCallRewrites: [
      {
        callId: sourceCallId,
        spawnBinding,
        expectedEmittedArguments: `{"task_name":"${originalProviderTaskName}","message":"ciphertext"}`,
        expectedEmittedArgumentsCanonical: `{"message":"ciphertext","task_name":"${originalProviderTaskName}"}`,
        emittedArguments: `{"task_name":"${wireTaskName}","message":"ciphertext"}`,
        emittedArgumentsCanonical: `{"message":"ciphertext","task_name":"${wireTaskName}"}`,
      },
    ],
  });
  await AppaProxyWireModel.finalizeNativeMcpBindingsAndMarkReady({
    sessionId: parent.session.id,
    ownerScopeHash,
    frameId: frame.id,
  });
  await AppaProxyWireModel.markIssued({
    sessionId: parent.session.id,
    ownerScopeHash,
    frameId: frame.id,
  });
  if (params.bindSpawnResult !== false) {
    await AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
      parentSessionId: parent.session.id,
      ownerScopeHash,
      profileId: agent.id,
      sourceCallId,
      childClientSessionId,
    });
  }
  await AppaProxySessionModel.releaseTurn(parent);
  return {
    scope,
    aliasId: alias.id,
    sourceCallId,
    spawnBinding,
    rootId,
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
  const turn = await AppaProxySessionModel.enterTurn({
    profileId: fixture.scope.profileId,
    ownerScopeHash: fixture.scope.ownerScopeHash,
    clientSessionId: fixture.child.childClientSessionId,
    parentClientSessionId: fixture.parentClientSessionId,
    spawnBinding: fixture.spawnBinding,
    rootId: `ignored-child-root-${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 10,
  });
  await AppaProxySessionModel.markChildStarted(turn);
  turn.session.childStartedAt = new Date();
  return turn;
}
