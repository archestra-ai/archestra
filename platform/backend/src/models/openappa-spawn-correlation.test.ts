import db, { schema } from "@/database";
import { openappaActor } from "@/openappa/actor";
import { expect, test } from "@/test";
import OpenAppaSpawnCorrelationModel from "./openappa-spawn-correlation";

test("recovers the child's recorded spawn, not another open sibling spawn", async ({
  makeOrganization,
}) => {
  const { id: organizationId } = await makeOrganization();
  const callerId = "user:test";
  const parentSessionId = `${callerId}|parent`;
  const childSessionId = `${parentSessionId}:child`;
  const root = openappaActor(parentSessionId);
  const scope = { organizationId, callerId, parentSessionId, childSessionId };

  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(childSessionId),
    root,
    organizationId,
    callerId,
    sessionId: childSessionId,
    parentId: parentSessionId,
    startDecision: { decision: "ack", protocol: 1 },
  });
  const spawn = (callId: string) => ({
    organizationId,
    callerId,
    sessionId: parentSessionId,
    operationId: `call:${callId}`,
    root,
    status: "complete",
    input: { semantic: { event: "tool_call", tool: "Agent", spawn: true } },
    decision: { decision: "allow_call" },
  });
  const prompt = (sessionId: string, callId: string, operationId: string) => ({
    organizationId,
    callerId,
    sessionId,
    operationId,
    root,
    status: "complete",
    input: { semantic: { event: "prompt", spawn_call_id: callId } },
    decision: { decision: "ack" },
  });
  await db.insert(schema.openappaOperationsTable).values(spawn("first"));
  expect(await OpenAppaSpawnCorrelationModel.soleOpenSpawn(scope)).toBeNull();
  await db
    .insert(schema.openappaOperationsTable)
    .values(prompt(childSessionId, "first", "prompt:child-start"));

  expect(await OpenAppaSpawnCorrelationModel.soleOpenSpawn(scope)).toBe(
    "first",
  );
  expect(
    await OpenAppaSpawnCorrelationModel.soleOpenSpawn({
      ...scope,
      childSessionId: `${parentSessionId}:other-child`,
    }),
  ).toBeNull();

  await db.insert(schema.openappaProcessedResultsTable).values({
    organizationId,
    callerId,
    sessionId: parentSessionId,
    toolCallId: "first",
    root,
    status: "complete",
    approvedOutput: "completed",
    decision: { decision: "tool_result" },
  });
  expect(await OpenAppaSpawnCorrelationModel.soleOpenSpawn(scope)).toBe(
    "first",
  );

  await db.insert(schema.openappaOperationsTable).values(spawn("second"));
  expect(await OpenAppaSpawnCorrelationModel.soleOpenSpawn(scope)).toBe(
    "first",
  );

  const siblingSessionId = `${parentSessionId}:sibling`;
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(siblingSessionId),
    root,
    organizationId,
    callerId,
    sessionId: siblingSessionId,
    parentId: parentSessionId,
    startDecision: { decision: "ack", protocol: 1 },
  });
  expect(
    await OpenAppaSpawnCorrelationModel.soleOpenSpawn({
      ...scope,
      childSessionId: siblingSessionId,
    }),
  ).toBeNull();
  await db.insert(schema.openappaOperationsTable).values({
    organizationId,
    callerId,
    sessionId: siblingSessionId,
    operationId: "call:sibling-web-search",
    root,
    status: "complete",
    input: {
      semantic: {
        event: "tool_call",
        tool: "WebSearch",
        spawn_call_id: "second",
      },
    },
    decision: { decision: "allow_call" },
  });
  expect(
    await OpenAppaSpawnCorrelationModel.soleOpenSpawn({
      ...scope,
      childSessionId: siblingSessionId,
    }),
  ).toBe("second");

  await db
    .insert(schema.openappaOperationsTable)
    .values(prompt(childSessionId, "second", "prompt:contradictory"));
  expect(await OpenAppaSpawnCorrelationModel.soleOpenSpawn(scope)).toBeNull();
});
