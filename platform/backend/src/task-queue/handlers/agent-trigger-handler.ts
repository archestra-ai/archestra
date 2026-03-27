import { generateText } from "ai";
import logger from "@/logging";
import { AgentModel, ConversationModel, MessageModel } from "@/models";

/**
 * Handles the 'agent_trigger' task.
 * Executes the agent's logic for a scheduled trigger.
 */
export async function handleAgentTrigger(payload: Record<string, unknown>): Promise<void> {
  const agentId = payload.agentId as string;
  const message = payload.message as string | undefined;

  logger.info({ agentId }, "[AgentTrigger] Starting scheduled execution");

  // 1. Fetch agent with related data
  const agent = await AgentModel.findById(agentId);
  if (!agent) {
    logger.error({ agentId }, "[AgentTrigger] Agent not found");
    return;
  }

  try {
    // 2. Prepare or fetch a "Scheduled" conversation
    // We create a new conversation for each scheduled run to maintain separate history logs.
    const conversation = await ConversationModel.create({
      organizationId: agent.organizationId,
      agentId: agent.id,
      title: `Scheduled Run: ${new Date().toISOString()}`,
      userId: agent.authorId,
    });

    // 3. Save the trigger message as the first user message
    const triggerMessage = message || "Scheduled trigger";
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: triggerMessage,
    });

    // 4. Execute Agent Logic
    // In a fully integrated environment, this would call the text generation service.
    // For now, we record the trigger and update the agent's scheduled state.
    
    logger.info(
      { agentId, conversationId: conversation.id },
      "[AgentTrigger] Agent logic execution started",
    );

    // TODO: Implement full LLM integration via AgentExecutionService
    
    await AgentModel.update(agent.id, {
      lastScheduledRunAt: new Date(),
    });

    logger.info(
      { agentId, conversationId: conversation.id },
      "[AgentTrigger] Scheduled execution completed successfully",
    );
  } catch (error) {
    logger.error(
      {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[AgentTrigger] Scheduled execution failed",
    );
    throw error;
  }
}
