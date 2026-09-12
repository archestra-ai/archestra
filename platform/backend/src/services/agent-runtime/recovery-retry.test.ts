import { sql } from "drizzle-orm";
import db from "@/database";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import { afterEach, expect, test, vi } from "@/test";
import { kubernetesAgentRuntimeBackendDriver as backend } from "./backends/kubernetes";
import { agentRunReconciler } from "./reconciler";

afterEach(() => vi.restoreAllMocks());

test("releases recovery after a heartbeat write fails so the next tick can retry", async ({
  makeAgent,
  makeUser,
}) => {
  const user = await makeUser();
  const agent = await makeAgent();
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: user.id,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
    lastHeartbeatAt: new Date(0),
  });
  await AgentRunModel.create({
    organizationId: agent.organizationId,
    agentId: agent.id,
    taskId: task.id,
    actorKind: "user",
    actorId: user.id,
    actorUserId: user.id,
    backend: "kubernetes",
    runtimeScope: "local",
    workloadName: `retry-${task.id}`,
    completionTarget: {
      type: "chatops",
      bindingId: crypto.randomUUID(),
      threadId: "recovery-test",
    },
  });
  let releasedLeases = 0;
  vi.spyOn(backend, "isEnabled", "get").mockReturnValue(true);
  // The cluster lease is an external boundary; task loading and writes use
  // the real database, including the failure before runtime adoption starts.
  vi.spyOn(backend, "withSessionLease").mockImplementation(
    async (_session, operation) => {
      await operation();
      releasedLeases++;
      return true;
    },
  );
  await db.execute(sql`
    CREATE FUNCTION reject_recovery_heartbeat() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'transient heartbeat write failure';
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.execute(sql`
    CREATE TRIGGER reject_recovery_heartbeat
      BEFORE UPDATE ON a2a_task
      FOR EACH ROW EXECUTE FUNCTION reject_recovery_heartbeat();
  `);
  try {
    await agentRunReconciler.reconcile();
    await expect.poll(() => releasedLeases).toBe(1);
    expect((await A2ATaskModel.findById(task.id))?.state).toBe(
      "TASK_STATE_WORKING",
    );
    await agentRunReconciler.reconcile();
    await expect.poll(() => releasedLeases).toBe(2);
  } finally {
    await db.execute(sql`DROP FUNCTION reject_recovery_heartbeat() CASCADE`);
  }
});
