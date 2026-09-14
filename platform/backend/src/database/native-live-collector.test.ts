import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";

const collectorPath = fileURLToPath(
  new URL(
    "../../../experiments/appa-proxy/native-live-collector.py",
    import.meta.url,
  ),
);

test("executes the complete native live collector PostgreSQL query", async ({
  makeAgent,
}) => {
  const agent = await makeAgent({ name: "Collector query test agent" });
  const runId = "collector-query-run";
  const requestKey = "collector-query-key";
  const parentSessionId = randomUUID();
  const childSessionId = randomUUID();
  const parentCallId = "collector-parent-call";
  const frameId = randomUUID();

  await db.insert(schema.appaProxySessionsTable).values([
    {
      id: parentSessionId,
      profileId: agent.id,
      ownerScopeHash: "a".repeat(64),
      clientSessionId: "collector-parent-session",
      provider: "openai",
      protocol: "openai-responses",
      model: "gpt-5.4",
      rootId: "collector-root",
    },
    {
      id: childSessionId,
      profileId: agent.id,
      ownerScopeHash: "a".repeat(64),
      clientSessionId: "collector-child-session",
      provider: "openai",
      protocol: "openai-responses",
      model: "gpt-5.4",
      rootId: "collector-root",
      parentSessionId,
      parentCallId,
    },
  ]);
  await db.insert(schema.appaProxyCallsTable).values([
    {
      sessionId: parentSessionId,
      callId: parentCallId,
      emittedName: "collaboration.spawn_agent",
      emittedArguments: `apc1.${parentCallId}.${"a".repeat(64)}.${"b".repeat(64)}`,
      emittedArgumentsCanonical: `apc1.${parentCallId}.${"a".repeat(64)}.${"b".repeat(64)}`,
      appaTargetName: "agent/fixture/lifecycle_child",
      appaTargetArguments: { request_key: requestKey, run_id: runId },
      spawnBinding: "collector-binding",
      spawnBindingConsumedAt: new Date(),
      state: "open",
    },
    {
      sessionId: childSessionId,
      callId: "collector-child-call",
      emittedName: "read_source",
      emittedArguments: "{}",
      emittedArgumentsCanonical: "{}",
      appaTargetName: "read_source",
      appaTargetArguments: {
        request_key: requestKey,
        run_id: runId,
        kind: "public",
      },
      state: "open",
    },
  ]);
  await db.insert(schema.appaProxyWireFramesTable).values({
    id: frameId,
    sessionId: parentSessionId,
    turnId: "collector-turn",
    kind: "model_response",
    state: "completed",
    protocol: "openai-responses",
    requestHash: "a".repeat(64),
    idempotencyKey: "collector-frame",
    payloadCiphertext: "collector-payload",
    payloadHash: "b".repeat(64),
    payloadBytes: 17,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await db.insert(schema.appaProxyWireAliasesTable).values({
    id: randomUUID(),
    sessionId: parentSessionId,
    frameId,
    kind: "task",
    position: 0,
    wireId: "collector-wire-task",
    logicalId: "collector-logical-task",
    sourceCallId: parentCallId,
    metadataCiphertext: "collector-metadata",
    metadataBytes: 18,
    childThreadId: "collector-child-session",
    consumedAt: new Date(),
  });

  const eventId = randomUUID();
  const requestBody = JSON.stringify({
    event_id: eventId,
    event: {
      event: "child_start",
      root_id: "collector-root",
      child_id: "collector-child-session",
      spawn_binding: "collector-binding",
    },
  });
  const requestSha256 = createHash("sha256").update(requestBody).digest("hex");
  await db.insert(schema.appaProxyEventsTable).values({
    sessionId: childSessionId,
    eventId,
    event: "child_start",
    requestBody,
    requestSha256,
    response: {
      protocol_version: 1,
      event_id: eventId,
      request_sha256: requestSha256,
      decision: { decision: "ack" },
    },
    settledAt: new Date("2026-01-01T00:00:05Z"),
  });

  const queryTemplate = collectorPostgresSql()
    .replaceAll(":'agent_id'", `'${agent.id}'`)
    .replaceAll(":'request_key'", `'${requestKey}'`)
    .replaceAll(":'run_id'", `'${runId}'`)
    .replaceAll(":'provider'", "'openai'")
    .replaceAll(":'protocol'", "'openai-responses'")
    .replaceAll(":'model'", "'gpt-5.4'")
    .replaceAll(":'interaction_type'", "'openai:responses'");
  const query = queryTemplate
    .replaceAll(":'local_target_name'", "'__not_local__'")
    .replaceAll(":'local_emitted_name'", "'__not_local__'")
    .replaceAll(":'local_arguments'", "'{}'");

  const result = await db.execute(sql.raw(query));

  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    json_build_object: {
      child_session_count: 1,
      event_receipts: [
        expect.objectContaining({
          settled_at: expect.stringMatching(
            /^2026-01-01T00:00:05(?:\.000)?(?:Z|\+00:00)$/,
          ),
        }),
      ],
      call_bindings: expect.arrayContaining([
        expect.objectContaining({
          child_actor_id: "collector-child-session",
          updated_at: expect.stringMatching(/(?:Z|[+-]\d{2}:\d{2})$/),
          authorization_at: expect.stringMatching(/(?:Z|[+-]\d{2}:\d{2})$/),
        }),
      ]),
      child_bindings: [
        expect.objectContaining({
          parent_emitted_name: "collaboration.spawn_agent",
          parent_target_name: "agent/fixture/lifecycle_child",
          parent_source_count: 0,
          signed_carrier_present: true,
          same_owner_scope: true,
          same_profile: true,
          same_root: true,
          spawn_binding_consumed: true,
          task_alias_count: 1,
          task_alias_matches_child: true,
          task_alias_consumed: true,
        }),
      ],
    },
  });

  await db.insert(schema.appaProxyCallsTable).values(
    (["open", "result_admitted"] as const).map((state) => ({
      sessionId: parentSessionId,
      callId: `parent-public-${state}`,
      emittedName: "read_source",
      emittedArguments: '{"kind":"public"}',
      emittedArgumentsCanonical: '{"kind":"public"}',
      appaTargetName: "mcp/my_gateway/native_live_fixture__read_source",
      appaTargetArguments: { kind: "public" },
      state,
    })),
  );
  const withParentRead = await db.execute(sql.raw(query));
  expect(withParentRead.rows[0]).toMatchObject({
    json_build_object: {
      child_bindings: [expect.objectContaining({ parent_source_count: 1 })],
    },
  });

  const otherSessionId = randomUUID();
  await db.insert(schema.appaProxySessionsTable).values({
    id: otherSessionId,
    profileId: agent.id,
    ownerScopeHash: "unrelated-collector-owner",
    clientSessionId: "unrelated-collector-session",
    rootId: "collector-root",
    provider: "openai",
    protocol: "openai-responses",
    model: "gpt-5.4",
    state: "ready",
  });
  const command = "node /operator/fixed-probe";
  const localArguments = { cmd: command, login: false };
  await db.insert(schema.appaProxyCallsTable).values(
    [parentSessionId, otherSessionId].map((sessionId) => ({
      sessionId,
      callId: `local-${sessionId}`,
      emittedName: "functions.exec_command",
      emittedArguments: JSON.stringify(localArguments),
      emittedArgumentsCanonical: JSON.stringify(localArguments),
      appaTargetName: "functions.exec_command",
      appaTargetArguments: localArguments,
      state: "result_admitted" as const,
    })),
  );
  const localQuery = queryTemplate
    .replaceAll(":'local_target_name'", "'functions.exec_command'")
    .replaceAll(":'local_emitted_name'", "'functions.exec_command'")
    .replaceAll(":'local_arguments'", `'${JSON.stringify(localArguments)}'`);
  const localResult = await db.execute(sql.raw(localQuery));
  expect(localResult.rows[0]).toMatchObject({
    json_build_object: {
      root_count: 1,
      root_local_calls: [
        expect.objectContaining({
          emitted_name: "functions.exec_command",
          exact_arguments: true,
        }),
      ],
    },
  });
});

function collectorPostgresSql(): string {
  const source = readFileSync(collectorPath, "utf8");
  const match = /POSTGRES_SQL = r'''\n([\s\S]*?)\n'''/.exec(source);
  if (!match) throw new Error("native live collector SQL was not found");
  return match[1];
}
