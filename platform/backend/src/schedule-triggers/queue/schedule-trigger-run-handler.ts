import { eq } from "drizzle-orm";
import type { InteractionSource } from "@shared";
import { executeA2AMessage } from "@/agents/a2a-executor";
import db from "@/database";
import logger from "@/logging";
import { AgentModel, UserModel } from "@/models";
import { taskQueueService } from "@/task-queue/task-queue";
import { scheduleTriggersTable } from "../models/schedule-trigger";
import { scheduleTriggerRunsTable } from "../models/schedule-trigger-run";
import { runSchedulerTick } from "../scheduler/scheduler";

export async function checkDueScheduleTriggersHandler() {
  await runSchedulerTick();
}

export async function scheduleTriggerRunExecuteHandler(
  payload: Record<string, unknown>,
) {
  const runId = payload.runId as string;

  // 1. Claim run (pending -> running)
  const [run] = await db
    .update(scheduleTriggerRunsTable)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(scheduleTriggerRunsTable.id, runId))
    .returning();

  if (!run) {
    logger.warn(
      { runId },
      "[ScheduleTriggers] Run not found or could not be claimed",
    );
    return;
  }

  let errorMsg: string | null = null;
  let status: "success" | "failed" = "failed";

  try {
    // 2. Validate actor exists
    const user = await UserModel.get(run.actorUserIdSnapshot);
    if (!user) {
      throw new Error(`Actor user ${run.actorUserIdSnapshot} not found`);
    }

    // 3. Validate agent exists
    const agent = await AgentModel.get(run.agentIdSnapshot);
    if (!agent) {
      throw new Error(`Agent ${run.agentIdSnapshot} not found`);
    }

    // 4. Validate actor has access to agent
    if (agent.organizationId !== user.organizationId) {
      throw new Error("Actor does not have access to agent's organization");
    }
    if (agent.scope === "personal" && agent.authorId !== user.id) {
      throw new Error("Actor does not have access to personal agent");
    }

    // 5. Execute via executeA2AMessage
    await executeA2AMessage({
      agentId: run.agentIdSnapshot,
      message: run.messageTemplateSnapshot,
      organizationId: run.organizationId,
      userId: run.actorUserIdSnapshot,
      source: "api" as InteractionSource, // Fallback source for triggered runs
    });

    status = "success";
  } catch (error: any) {
    logger.error(
      { runId, error: error.message || String(error) },
      "[ScheduleTriggers] Run execution failed",
    );
    errorMsg = error.message || String(error);
    status = "failed";
  }

  // 6. Record outcome in run
  await db
    .update(scheduleTriggerRunsTable)
    .set({
      status,
      completedAt: new Date(),
      ...(errorMsg ? { error: errorMsg } : {}),
    })
    .where(eq(scheduleTriggerRunsTable.id, runId));

  // 7. Record outcome in parent trigger
  await db
    .update(scheduleTriggersTable)
    .set({
      lastRunAt: new Date(),
      lastRunStatus: status,
      ...(errorMsg ? { lastError: errorMsg } : { lastError: null }),
    })
    .where(eq(scheduleTriggersTable.id, run.triggerId));
}
