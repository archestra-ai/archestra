import { executeA2AMessage } from "@/agents/a2a-executor";
import db, { schema } from "@/database";
import { eq } from "drizzle-orm";
import logger from "@/logging";
import type { TaskHandler } from "@/types";
import parser from "cron-parser";

export const handleAgentRun: TaskHandler = async (payload: Record<string, unknown>) => {
  const { agentId, organizationId, userId, message } = payload as any;

  if (!agentId || !organizationId || !userId) {
    throw new Error("Missing required fields in agent_run payload");
  }

  logger.info({ agentId, organizationId, userId }, "Executing scheduled agent run");

  try {
    // 1. Execute the agent message
    await executeA2AMessage({
      agentId,
      organizationId,
      userId,
      message: message || "Scheduled run triggered",
      source: "api", // Mark as API-triggered for logs
    });

    // 2. Calculate and update the next run time
    const agent = await db.query.agentsTable.findFirst({
      where: eq(schema.agentsTable.id, agentId),
    });

    if (agent?.schedule) {
      const interval = parser.parseExpression(agent.schedule);
      const nextRunAt = interval.next().toDate();

      await db
        .update(schema.agentsTable)
        .set({ nextRunAt })
        .where(eq(schema.agentsTable.id, agentId));
      
      logger.info({ agentId, nextRunAt }, "Updated agent next_run_at");
    }
  } catch (error) {
    logger.error({ agentId, error }, "Failed to execute scheduled agent run");
    throw error;
  }
};
