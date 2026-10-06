import db, { schema } from "@/database";
import { openappaActor } from "@/openappa/actor";
import { expect, test } from "@/test";
import OpenAppaSessionModel from "./openappa-session";
import OpenAppaSpawnCorrelationModel from "./openappa-spawn-correlation";

test("recognizes only completed caller-bound released fork bindings in a batch", async ({
  makeOrganization,
}) => {
  const { id: organizationId } = await makeOrganization();
  const otherOrganization = await makeOrganization();
  const scope = {
    organizationId,
    callerId: "user:test",
    parentSessionId: "parent",
    toolCallIds: [
      "fork",
      "ordinary",
      "denied",
      "empty",
      "invalid",
      "pending",
      "other-caller",
      "other-parent",
      "other-org",
    ],
  };
  const base = {
    organizationId,
    callerId: scope.callerId,
    sessionId: scope.parentSessionId,
    root: openappaActor(scope.parentSessionId),
    status: "complete",
    input: {
      semantic: {
        event: "tool_call",
        spawn: true,
        tool: "agent__worker",
        arguments: { message: "bounded request" },
      },
    },
    decision: { decision: "allow_call", spawn_binding: "retained-fork" },
  };
  await db.insert(schema.openappaOperationsTable).values([
    { ...base, operationId: "call:fork" },
    {
      ...base,
      operationId: "call:ordinary",
      decision: { decision: "allow_call" },
    },
    {
      ...base,
      operationId: "call:denied",
      decision: { decision: "deny_call", spawn_binding: "unreleased" },
    },
    {
      ...base,
      operationId: "call:empty",
      decision: { decision: "allow_call", spawn_binding: "" },
    },
    {
      ...base,
      operationId: "call:invalid",
      decision: { decision: "allow_call", spawn_binding: true },
    },
    { ...base, operationId: "call:pending", status: "pending", decision: null },
    { ...base, operationId: "call:other-caller", callerId: "user:other" },
    { ...base, operationId: "call:other-parent", sessionId: "other-parent" },
    {
      ...base,
      operationId: "call:other-org",
      organizationId: otherOrganization.id,
    },
  ]);
  expect(
    await OpenAppaSpawnCorrelationModel.releasedSpawnCallIds(scope),
  ).toEqual(new Set(["fork"]));
  expect(
    await OpenAppaSpawnCorrelationModel.releasedSpawnCall({
      ...scope,
      toolCallId: "fork",
    }),
  ).toEqual({
    tool: "agent__worker",
    arguments: { message: "bounded request" },
  });
  expect(
    await OpenAppaSpawnCorrelationModel.releasedSpawnCall({
      ...scope,
      toolCallId: "ordinary",
    }),
  ).toBeNull();
  expect(
    await OpenAppaSpawnCorrelationModel.releasedSpawnCall({
      ...scope,
      toolCallId: "fork",
      callerId: "user:other",
    }),
  ).toBeNull();
  expect(
    await OpenAppaSpawnCorrelationModel.releasedSpawnCallIds({
      ...scope,
      callerId: undefined,
    }),
  ).toEqual(new Set());
  expect(
    await OpenAppaSpawnCorrelationModel.releasedSpawnCallIds({
      ...scope,
      toolCallIds: [],
    }),
  ).toEqual(new Set());
});

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

test("a compacted spawn still names the agent from its allowed arguments", async ({
  makeOrganization,
}) => {
  const { id: organizationId } = await makeOrganization();
  const callerId = "user:test";
  const parentSessionId = `${callerId}|parent`;
  const root = openappaActor(parentSessionId);
  await db.insert(schema.openappaOperationsTable).values({
    organizationId,
    callerId,
    sessionId: parentSessionId,
    operationId: "call:spawn-auditor",
    root,
    status: "complete",
    input: {
      semantic: {
        event: "tool_call",
        tool: "Agent",
        spawn: true,
        arguments: {
          name: "auditor",
          description: "Audit the triggers",
          prompt: "Audit the schedule triggers.",
        },
      },
    },
    decision: { decision: "allow_call" },
  });
  await db.insert(schema.openappaProcessedResultsTable).values({
    organizationId,
    callerId,
    sessionId: parentSessionId,
    toolCallId: "spawn-auditor",
    root,
    status: "complete",
    approvedOutput:
      "Spawned successfully.\nagent_id: auditor@team\nname: auditor",
    decision: { decision: "ack" },
  });
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(parentSessionId),
    root,
    organizationId,
    callerId,
    sessionId: parentSessionId,
    parentId: `${callerId}|grandparent`,
    startDecision: { decision: "ack" },
  });

  expect(
    await OpenAppaSpawnCorrelationModel.allowedSpawnAliases({
      organizationId,
      callerId,
      parentSessionId,
    }),
  ).toEqual([
    {
      spawnCallId: "spawn-auditor",
      name: "auditor",
      description: "Audit the triggers",
      launchText:
        "Spawned successfully.\nagent_id: auditor@team\nname: auditor",
    },
  ]);
  expect(
    await OpenAppaSessionModel.familySession({
      organizationId,
      sessionId: parentSessionId,
      callerId,
    }),
  ).toEqual({
    sessionId: parentSessionId,
    parentId: `${callerId}|grandparent`,
    callerId,
  });
});
