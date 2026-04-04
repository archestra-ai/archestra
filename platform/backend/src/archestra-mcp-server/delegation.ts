import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_TOOL_PREFIX, slugify } from "@shared";
import { z } from "zod";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import { AgentTeamModel, ToolModel } from "@/models";
import { ProviderError } from "@/routes/chat/errors";
import { errorResult, isAbortLikeError, successResult } from "./helpers";
import type { ArchestraContext } from "./types";

export const delegationToolArgsSchema = z.object({
  message: z.string().trim().min(1, "message is required."),
});

// === Exports ===

/**
 * Get agent delegation tools for an agent from the database
 * Each configured delegation becomes a separate tool (e.g., delegate_to_research_bot)
 * Note: Agent tools are separate from Archestra tools - they enable agent-to-agent delegation
 */
export async function getAgentTools(context: {
  agentId: string;
  organizationId: string;
  userId?: string;
  /** Skip user access check (for A2A/ChatOps flows where caller has elevated permissions) */
  skipAccessCheck?: boolean;
}): Promise<Tool[]> {
  const { agentId, organizationId, userId, skipAccessCheck } = context;

  // Get all delegation tools assigned to this agent
  const allToolsWithDetails =
    await ToolModel.getDelegationToolsByAgent(agentId);

  // Filter by user access if user ID is provided (skip for A2A/ChatOps flows)
  let accessibleTools = allToolsWithDetails;
  if (userId && !skipAccessCheck) {
    // Check if user has agent admin permission directly (don't trust caller)
    const isAgentAdmin = await userHasPermission(
      userId,
      organizationId,
      "agent",
      "admin",
    );

    const userAccessibleAgentIds =
      await AgentTeamModel.getUserAccessibleAgentIds(userId, isAgentAdmin);
    accessibleTools = allToolsWithDetails.filter((t) =>
      userAccessibleAgentIds.includes(t.targetAgent.id),
    );
  }

  logger.debug(
    {
      agentId,
      organizationId,
      userId,
      allToolCount: allToolsWithDetails.length,
      accessibleToolCount: accessibleTools.length,
    },
    "Fetched agent delegation tools from database",
  );

  // Convert DB tools to MCP Tool format
  return accessibleTools.map((t) => {
    const description = t.targetAgent.description
      ? `Delegate task to agent: ${t.targetAgent.name}. ${t.targetAgent.description.substring(0, 400)}`
      : `Delegate task to agent: ${t.targetAgent.name}`;

    return {
      name: t.tool.name,
      title: t.targetAgent.name,
      description,
      inputSchema: t.tool.parameters as Tool["inputSchema"],
      annotations: {},
      _meta: { targetAgentId: t.targetAgent.id },
    };
  });
}

export async function handleDelegation(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agentId, organizationId, tokenAuth } = context;

  const message = args?.message as string;

  if (!message) {
    return errorResult("message is required.");
  }

  if (!agentId) {
    return errorResult("No agent context available.");
  }

  if (!organizationId) {
    return errorResult("Organization context not available.");
  }

  // Extract target agent slug from tool name
  const targetAgentSlug = toolName.replace(AGENT_TOOL_PREFIX, "");

  // Get all delegation targets configured for this agent
  const delegations = await ToolModel.getDelegationToolsByAgent(agentId);

  // Find matching delegation by slug
  const delegation = delegations.find(
    (d) => slugify(d.targetAgent.name) === targetAgentSlug,
  );

  if (!delegation) {
    return errorResult("Agent not found or not configured for delegation.");
  }

  // Check user has access if user token is being used
  const userId = tokenAuth?.userId;
  if (userId && organizationId) {
    const isAgentAdmin = await userHasPermission(
      userId,
      organizationId,
      "agent",
      "admin",
    );

    const userAccessibleAgentIds =
      await AgentTeamModel.getUserAccessibleAgentIds(userId, isAgentAdmin);
    if (!userAccessibleAgentIds.includes(delegation.targetAgent.id)) {
      return errorResult("You don't have access to this agent.");
    }
  }

  try {
    // Use sessionId from context, or fall back to conversationId for chat context
    const sessionId = context.sessionId || context.conversationId;

    logger.info(
      {
        agentId,
        targetAgentId: delegation.targetAgent.id,
        targetAgentName: delegation.targetAgent.name,
        organizationId,
        userId: userId || "system",
        sessionId,
      },
      "Executing agent delegation tool",
    );

    const result = await executeA2AMessage({
      agentId: delegation.targetAgent.id,
      message,
      organizationId,
      userId: userId || "system",
      sessionId,
      // Pass the current delegation chain so the child can extend it
      parentDelegationChain: context.delegationChain || context.agentId,
      // Propagate conversationId for browser tab isolation
      conversationId: context.conversationId,
      abortSignal: context.abortSignal,
      // We only need to propagate whether the parent was already unsafe at the
      // delegation boundary. The child re-evaluates its own tool results and
      // records its own unsafe boundary instead of inheriting the parent's.
      parentContextIsTrusted: context.contextIsTrusted,
    });

    return successResult(result.text);
  } catch (error) {
    if (isAbortLikeError(error)) {
      logger.info(
        { agentId, targetAgentId: delegation.targetAgent.id },
        "Agent delegation was aborted",
      );
      throw error;
    }
    logger.error(
      { error, agentId, targetAgentId: delegation.targetAgent.id },
      "Agent delegation tool execution failed",
    );
    // Re-throw ProviderError so it propagates to the parent stream's onError
    // with the correct provider info (the subagent can't produce output)
    if (error instanceof ProviderError) {
      throw error;
    }
    return errorResult(
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}
