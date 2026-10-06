import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
  VirtualApiKeyModel,
} from "@/models";
import { openappaActor } from "@/openappa/actor";
import { expect, test } from "@/test";
import { assertRuntimeCredentialLease } from "./credential-lease";

test("a runtime credential remains bound to its actual caller, Agent, placement, deadline and root", async ({
  makeOrganization,
  makeUser,
  makeAgent,
  makeMember,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id);
  const agent = await makeAgent({ organizationId: organization.id });
  const { virtualKey: key } = await VirtualApiKeyModel.create({
    organizationId: organization.id,
    scope: "personal",
    authorId: user.id,
    name: "Issued runtime key",
  });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.createForRun({
    contextId: context.id,
    agentId: agent.id,
  });
  const workloadName = `runtime-${task.id}`;
  const run = await AgentRunModel.create({
    organizationId: organization.id,
    taskId: task.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    workloadName,
    backend: "kubernetes",
    runtimeScope: "issued-scope",
    virtualApiKeyId: key.id,
  });
  await AgentWorkspaceModel.create({
    organizationId: organization.id,
    workloadName,
    agentId: agent.id,
    actorKind: "user",
    actorId: user.id,
    backend: "kubernetes",
    runtimeScope: "issued-scope",
    lastTaskId: task.id,
    state: "active",
    activeTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const request = {
    organizationId: organization.id,
    virtualApiKeyId: key.id,
    agentId: agent.id,
    callerId: `user:${user.id}`,
    sessionId: workloadName,
    parentId: undefined,
    enforceSession: true,
  };
  await expect(assertRuntimeCredentialLease(request)).resolves.toBeUndefined();
  await AgentRunModel.close({ id: run.id });
  await expect(assertRuntimeCredentialLease(request)).rejects.toMatchObject({
    statusCode: 401,
  });
  await db
    .update(schema.agentRunsTable)
    .set({ endedAt: null })
    .where(eq(schema.agentRunsTable.id, run.id));
  await expect(
    assertRuntimeCredentialLease({
      ...request,
      sessionId: `${request.callerId}|${workloadName}`,
    }),
  ).resolves.toBeUndefined();
  for (const invalid of [
    { ...request, callerId: "user:reassigned" },
    { ...request, callerId: `virtual-key:${key.id}` },
    { ...request, agentId: crypto.randomUUID() },
    { ...request, sessionId: "fresh-root" },
    { ...request, sessionId: `user:other|${workloadName}` },
    { ...request, sessionId: undefined },
    { ...request, parentId: "foreign-parent", sessionId: "child" },
  ]) {
    await expect(assertRuntimeCredentialLease(invalid)).rejects.toMatchObject({
      statusCode: 401,
    });
  }
  // Enforcement-off requests retain their previous wire behavior, not another caller.
  await expect(
    assertRuntimeCredentialLease({
      ...request,
      enforceSession: false,
      sessionId: undefined,
    }),
  ).resolves.toBeUndefined();
  await expect(
    assertRuntimeCredentialLease({
      ...request,
      enforceSession: false,
      callerId: "user:other",
    }),
  ).rejects.toMatchObject({ statusCode: 401 });
  const rootId = `${request.callerId}|${workloadName}`;
  await db.insert(schema.openappaSessionsTable).values({
    organizationId: organization.id,
    callerId: request.callerId,
    sessionId: rootId,
    root: openappaActor(rootId),
    actor: openappaActor(rootId),
    startDecision: { decision: "ack" },
  });
  await expect(
    assertRuntimeCredentialLease({
      ...request,
      sessionId: "child",
      parentId: workloadName,
    }),
  ).resolves.toBeUndefined();
  const foreignParent = `${request.callerId}|foreign-root`;
  await db.insert(schema.openappaSessionsTable).values({
    organizationId: organization.id,
    callerId: request.callerId,
    sessionId: foreignParent,
    root: openappaActor(foreignParent),
    actor: openappaActor(foreignParent),
    startDecision: { decision: "ack" },
  });
  await expect(
    assertRuntimeCredentialLease({
      ...request,
      sessionId: "child",
      parentId: foreignParent,
    }),
  ).rejects.toMatchObject({ statusCode: 401 });
  await db
    .update(schema.agentWorkspacesTable)
    .set({ runtimeScope: "changed-scope" })
    .where(eq(schema.agentWorkspacesTable.workloadName, workloadName));
  await expect(assertRuntimeCredentialLease(request)).rejects.toMatchObject({
    statusCode: 401,
  });
  await db
    .update(schema.agentWorkspacesTable)
    .set({ runtimeScope: "issued-scope", expiresAt: new Date(0) })
    .where(eq(schema.agentWorkspacesTable.workloadName, workloadName));
  await expect(assertRuntimeCredentialLease(request)).rejects.toMatchObject({
    statusCode: 401,
  });
});
