import { and, eq, sql } from "drizzle-orm";
import type { InteractionSource } from "@shared";
import { executeA2AMessage } from "@/agents/a2a-executor";
import db from "@/database";
import logger from "@/logging";
import { AgentModel, UserModel } from "@/models";
import { agentScheduleTriggersTable } from "../models/agent-schedule-trigger";
import { agentScheduleTriggerRunsTable } from "../models/agent-schedule-trigger-run";
import { runSchedulerTick } from "../scheduler/scheduler";

export async function checkDueScheduleTriggersHandler() {
  await runSchedulerTick();
}

export async function scheduleTriggerRunExecuteHandler(
  payload: Record<string, unknown>,
) {
  const runId = payload.runId as string;

  // 1. Claim run (pending -> running) with strong atomic guard
  const [run] = await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(agentScheduleTriggerRunsTable)
      .where(
        and(
          eq(agentScheduleTriggerRunsTable.id, runId),
          eq(agentScheduleTriggerRunsTable.status, "pending"),
        ),
      )
      .for("update", { skipLocked: true });

    if (!target) return [];

    return await tx
      .update(agentScheduleTriggerRunsTable)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(agentScheduleTriggerRunsTable.id, runId))
      .returning();
  });

  if (!run) {
    logger.debug({ runId }, "[AgentScheduleTriggers] Run already claimed or missing");
    return;
  }

  let errorMsg: string | null = null;
  let status: "success" | "failed" = "failed";

  try {
    const user = await UserModel.get(run.actorUserIdSnapshot);
    if (!user) throw new Error(`Actor user ${run.actorUserIdSnapshot} not found`);

    const agent = await AgentModel.get(run.agentIdSnapshot);
    if (!agent) throw new Error(`Agent ${run.agentIdSnapshot} not found`);

    if (agent.organizationId !== user.organizationId) {
      throw new Error("Actor does not have access to agent's organization");
    }

    // 2. Execute via executeA2AMessage with correct source
    await executeA2AMessage({
      agentId: run.agentIdSnapshot,
      message: run.messageTemplateSnapshot,
      organizationId: run.organizationId,
      userId: run.actorUserIdSnapshot,
      source: "schedule" as InteractionSource, // Refined semantic correctness
    });

    status = "success";
  } catch (error: any) {
    logger.error({ runId, error: error.message }, "[AgentScheduleTriggers] Execution failed");
    errorMsg = error.message || String(error);
  }

  // 3. Finalize run record
  await db
    .update(agentScheduleTriggerRunsTable)
    .set({
      status,
      completedAt: new Date(),
      error: errorMsg,
    })
    .where(eq(agentScheduleTriggerRunsTable.id, runId));

  // 4. Record summary in trigger for observability
  await db
    .update(agentScheduleTriggersTable)
    .set({
      lastRunStatus: status,
      lastError: errorMsg,
    })
    .where(eq(agentScheduleTriggersTable.id, run.triggerId));
}
