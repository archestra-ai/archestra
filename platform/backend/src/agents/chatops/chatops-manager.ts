import { isMention, parseMessage } from "@shared";
import logger from "@/logging";
import { AgentModel, SessionModel, TeamModel } from "@/models";
import { type InteractionSource, InteractionSourceSchema } from "@/types";
import { type FastifyRequest } from "fastify";
import {
  type ChatOpsMessage,
  type ChatOpsResponse,
  ChatOpsResponseSchema,
} from "@/types/chatops";
import { processAgentMessage } from "./agent-processor";

/**
 * Orchestrates ChatOps message processing.
 * 1. Resolves/creates session
 * 2. Resolves target agent (sticky or mentioned)
 * 3. Delegates to agent-processor for LLM execution
 */
export async function processMessage(
  message: ChatOpsMessage,
  request: FastifyRequest,
): Promise<ChatOpsResponse> {
  const { channelId, teamId, userId, text, threadTs } = message;

  logger.info(
    { channelId, teamId, userId, threadTs },
    "Processing ChatOps message",
  );

  // 1. Resolve session
  const session = await SessionModel.getOrCreateChatOpsSession({
    channelId,
    teamId,
    threadTs: threadTs || message.ts,
  });

  // 2. Resolve user/membership
  const team = await TeamModel.getByExternalId(teamId);
  if (!team) {
    throw new Error(`Team ${teamId} not found`);
  }

  // 3. Resolve target agent
  let targetAgentId = session.metadata?.agentId;

  // If there's a mention, it always overrides sticky agent
  const { mentions } = parseMessage(text);
  if (mentions.length > 0) {
    const mention = mentions[0];
    const agent = await AgentModel.getByMention(mention, team.organizationId);
    if (agent) {
      targetAgentId = agent.id;
      // Update session to make this agent "sticky"
      await SessionModel.updateMetadata(session.id, { agentId: targetAgentId });
    }
  }

  if (!targetAgentId) {
    logger.warn({ session: session.id }, "No target agent resolved for message");
    return ChatOpsResponseSchema.parse({
      text: "I'm not sure which agent you're talking to. Please mention an agent to start.",
    });
  }

  const agent = await AgentModel.findById(targetAgentId);
  if (!agent) {
    throw new Error(`Agent ${targetAgentId} not found`);
  }

  // 4. Process with agent
  return await processAgentMessage(agent, message, session, request);
}
