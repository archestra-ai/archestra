import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import { AgentModel } from "@/models";

export async function handleAgentRun(payload: Record<string, unknown>): Promise<void> {
  const rawAgentId = payload.agentId;
  if (typeof rawAgentId !== "string" || rawAgentId.length === 0) {
    throw new Error("agentId is required for agent_run task");
  }
  const agentId = rawAgentId;
  const agent = await AgentModel.findById(agentId);
  if (!agent) {
    logger.error({ agentId }, "Agent not found for scheduled run");
    return;
  }

  if (agent.agentType !== "agent") {
    logger.error({ agentId, agentType: agent.agentType }, "Scheduled run only supported for internal agents");
    return;
  }

  const message = agent.scheduledMessage || "Run scheduled task";

  logger.info({ agentId, agentName: agent.name }, "Starting scheduled agent run");

  try {
    await executeA2AMessage({
      agentId: agent.id,
      message,
      organizationId: agent.organizationId,
      userId: agent.authorId || "system", // Use authorId if available, fallback to system
    });

    logger.info({ agentId, agentName: agent.name }, "Scheduled agent run completed successfully");
  } catch (error) {
    logger.error(
      {
        agentId: agent.id,
        agentName: agent.name,
        error: error instanceof Error ? error.message : String(error),
      },
      "Scheduled agent run failed",
    );
    throw error;
  } finally {
    // Always update lastScheduledRunAt to prevent infinite loops on failure
    await AgentModel.updateLastScheduledRunAt(agent.id, new Date());
  }
}
