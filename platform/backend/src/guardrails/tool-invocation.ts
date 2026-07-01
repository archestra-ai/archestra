import {
  buildArchestraToolRefusalMetadata,
  isAgentTool,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { disabledToolsNotRunMessage } from "@/archestra-mcp-server/tool-recovery-messages";
import logger from "@/logging";
import {
  AgentTeamModel,
  OrganizationModel,
  TeamModel,
  ToolInvocationPolicyModel,
  ToolModel,
} from "@/models";
import type { PolicyEvaluationContext } from "@/models/tool-invocation-policy";
import type { DiscoveredToolPolicy, GlobalToolPolicy } from "@/types";
import { defaultDiscoveredToolPolicy } from "@/types";

/**
 * Result returned when tool invocation policies block a tool call.
 */
export interface PolicyBlockResult {
  refusalMessage: string;
  contentMessage: string;
  /** Human-readable reason why the tool call was blocked */
  reason: string;
  /** The specific tool that triggered the block */
  blockedToolName: string;
  /** All tool call names in the batch (all are blocked when any one is) */
  allToolCallNames: string[];
}

export async function evaluateSingleMcpToolInvocationPolicy(params: {
  agentId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  organizationId?: string;
  contextIsTrusted: boolean;
  externalAgentId?: string;
  enforceApprovalRequired?: boolean;
  /**
   * Pre-fetched set of the agent's assigned tool names. When supplied (e.g. the
   * run_tool dispatch already computed it for its existence pre-check), it is
   * reused instead of re-querying ToolModel.getAssignedToolNames here.
   */
  enabledToolNames?: Set<string>;
}): Promise<PolicyBlockResult | null> {
  if (
    archestraMcpBranding.isToolName(params.toolName) ||
    isAgentTool(params.toolName)
  ) {
    return null;
  }

  const [teamIds, organizationPolicies, enabledToolNames] = await Promise.all([
    AgentTeamModel.getTeamsForAgent(params.agentId),
    params.organizationId
      ? OrganizationModel.getById(params.organizationId).then((organization) =>
          organization
            ? {
                globalToolPolicy: organization.globalToolPolicy,
                discoveredToolPolicy: organization.discoveredToolPolicy,
              }
            : undefined,
        )
      : Promise.resolve(undefined),
    params.enabledToolNames ?? ToolModel.getAssignedToolNames(params.agentId),
  ]);
  const { globalToolPolicy, discoveredToolPolicy } =
    organizationPolicies ?? (await getToolPolicies(params.agentId));
  const policyContext = {
    teamIds,
    externalAgentId: params.externalAgentId,
  };

  const policyBlock = await evaluatePolicies(
    [
      {
        toolCallName: params.toolName,
        toolCallArgs: JSON.stringify(params.toolInput),
      },
    ],
    params.agentId,
    policyContext,
    params.contextIsTrusted,
    enabledToolNames,
    globalToolPolicy,
    discoveredToolPolicy,
  );
  if (policyBlock) {
    return policyBlock;
  }

  if (params.enforceApprovalRequired === false) {
    return null;
  }

  const requiresApproval =
    await ToolInvocationPolicyModel.checkApprovalRequired(
      params.toolName,
      params.toolInput,
      policyContext,
      globalToolPolicy,
      discoveredToolPolicy,
    );
  if (!requiresApproval) {
    return null;
  }

  return buildToolInvocationPolicyBlockResult({
    toolName: params.toolName,
    toolInput: params.toolInput,
    reason: TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  });
}

/**
 * This method will evaluate whether, based on the tool invocation policies assigned to the specified agent,
 * if the tool call is allowed or blocked.
 *
 * If this method returns non-null it is because the tool call was blocked and we are returning a refusal message
 * (in the format of an assistant message with a refusal)
 *
 * @param toolCalls - The tool calls to evaluate
 * @param agentId - The agent ID to evaluate policies for
 * @param context - Policy evaluation context (profileId, teamId, headers)
 * @param contextIsTrusted - Whether the context is trusted
 * @param enabledToolNames - Optional set of tool names that are enabled in the request.
 *                          If provided, tool calls not in this set will be filtered and reported as disabled.
 * @param globalToolPolicy - The org's global tool policy (governs non-discovered tools).
 * @param discoveredToolPolicy - The org's discovered-tool policy (governs llm-proxy discovered tools).
 */
export const evaluatePolicies = async (
  toolCalls: Array<{ toolCallName: string; toolCallArgs: string }>,
  agentId: string,
  context: PolicyEvaluationContext,
  contextIsTrusted: boolean,
  enabledToolNames: Set<string>,
  globalToolPolicy: GlobalToolPolicy,
  // Defaults to the discovered-tool equivalent of globalToolPolicy so callers
  // that don't distinguish discovered tools keep single-policy behavior;
  // production passes it explicitly.
  discoveredToolPolicy: DiscoveredToolPolicy = defaultDiscoveredToolPolicy(
    globalToolPolicy,
  ),
): Promise<PolicyBlockResult | null> => {
  logger.debug(
    {
      agentId,
      toolCallCount: toolCalls.length,
      contextIsTrusted,
      globalToolPolicy,
    },
    "[toolInvocation] evaluatePolicies: starting evaluation",
  );

  if (toolCalls.length === 0) {
    return null;
  }

  // Filter out disabled tools (not in request's tools list)
  // This is required because otherwise the tool invocation policies will be evaluated
  // for tools that are disabled during chat session.
  // Note: archestra__* tools are always enabled (built-in tools that bypass policies)
  const isToolEnabled = (toolName: string) =>
    archestraMcpBranding.isToolName(toolName) ||
    enabledToolNames?.has(toolName);

  let disabledToolNames: string[] = [];
  let filteredToolCalls = toolCalls;
  if (enabledToolNames && enabledToolNames.size > 0) {
    disabledToolNames = toolCalls
      .filter((tc) => !isToolEnabled(tc.toolCallName))
      .map((tc) => tc.toolCallName);
    filteredToolCalls = toolCalls.filter((tc) =>
      isToolEnabled(tc.toolCallName),
    );
    if (disabledToolNames.length > 0) {
      logger.info(
        { disabledTools: disabledToolNames },
        "[toolInvocation] evaluatePolicies: disabled tools filtered out",
      );
    }
  }

  // If any tools were disabled, return distinct message about them
  if (disabledToolNames.length > 0) {
    const message = disabledToolsNotRunMessage(disabledToolNames);
    const reason = TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON;
    return {
      refusalMessage: message,
      contentMessage: message,
      reason,
      blockedToolName: disabledToolNames[0],
      allToolCallNames: disabledToolNames,
    };
  }

  // If all tools were filtered out, nothing to evaluate
  if (filteredToolCalls.length === 0) {
    return null;
  }

  // Parse all tool arguments upfront
  const parsedToolCalls = filteredToolCalls.map((toolCall) => {
    /**
     * According to the OpenAI TS SDK types.. toolCall.function.arguments mentions:
     *
     * The arguments to call the function with, as generated by the model in JSON format. Note that the model does
     * not always generate valid JSON, and may hallucinate parameters not defined by your function schema. Validate
     * the arguments in your code before calling your function.
     *
     * So it is possible that the "JSON" here is malformed because the model hallucinated parameters and we
     * may need to explicitly handle this case in the future...
     */
    return {
      toolCallName: toolCall.toolCallName,
      toolInput: JSON.parse(toolCall.toolCallArgs),
    };
  });

  // Evaluate all tool calls in batch (1-2 queries total instead of N queries)
  const { isAllowed, reason, toolCallName } =
    await ToolInvocationPolicyModel.evaluateBatch(
      agentId,
      parsedToolCalls,
      context,
      contextIsTrusted,
      globalToolPolicy,
      discoveredToolPolicy,
    );

  logger.debug(
    { agentId, isAllowed, reason, toolCallName },
    "[toolInvocation] evaluatePolicies: batch evaluation result",
  );

  if (!isAllowed && toolCallName) {
    const toolInput =
      parsedToolCalls.find((tc) => tc.toolCallName === toolCallName)
        ?.toolInput ?? {};

    logger.debug(
      { agentId, toolCallName, reason },
      "[toolInvocation] evaluatePolicies: tool invocation blocked",
    );
    return buildToolInvocationPolicyBlockResult({
      toolName: toolCallName,
      toolInput,
      reason,
      allToolCallNames: filteredToolCalls.map((tc) => tc.toolCallName),
    });
  }

  logger.debug(
    { agentId, toolCallCount: toolCalls.length },
    "[toolInvocation] evaluatePolicies: all tool calls allowed",
  );
  return null;
};

/**
 * Resolve both tool policies for an agent in a single organization fetch:
 * 1. Use the organization of the agent's first team, if any.
 * 2. Fallback to the first organization in the database.
 * Global defaults to "permissive" and discovered defaults to "apply_policies"
 * when no organization can be resolved.
 */
export async function getToolPolicies(agentId: string): Promise<{
  globalToolPolicy: GlobalToolPolicy;
  discoveredToolPolicy: DiscoveredToolPolicy;
}> {
  const fallback = {
    globalToolPolicy: "permissive",
    discoveredToolPolicy: "relaxed",
  } as const;
  const agentTeamIds = await AgentTeamModel.getTeamsForAgent(agentId);

  // Agent has teams - get organization from first team
  if (agentTeamIds.length > 0) {
    const teams = await TeamModel.findByIds(agentTeamIds);
    if (teams.length > 0 && teams[0].organizationId) {
      const organizationId = teams[0].organizationId;
      const organization = await OrganizationModel.getById(organizationId);
      if (!organization) {
        logger.warn(
          { agentId, organizationId },
          `getToolPolicies: organization not found, defaulting to ${fallback.globalToolPolicy}`,
        );
        return fallback;
      }
      logger.debug(
        {
          agentId,
          organizationId,
          globalToolPolicy: organization.globalToolPolicy,
          discoveredToolPolicy: organization.discoveredToolPolicy,
        },
        "getToolPolicies: resolved policies from team organization",
      );
      return {
        globalToolPolicy: organization.globalToolPolicy,
        discoveredToolPolicy: organization.discoveredToolPolicy,
      };
    }
  }

  // Agent has no teams - fallback to first organization (avoid double fetch)
  const firstOrg = await OrganizationModel.getFirst();
  if (!firstOrg) {
    logger.warn(
      { agentId },
      `getToolPolicies: could not resolve organization, defaulting to ${fallback.globalToolPolicy}`,
    );
    return fallback;
  }
  logger.debug(
    {
      agentId,
      organizationId: firstOrg.id,
      globalToolPolicy: firstOrg.globalToolPolicy,
      discoveredToolPolicy: firstOrg.discoveredToolPolicy,
    },
    "getToolPolicies: agent has no teams - using fallback organization",
  );
  return {
    globalToolPolicy: firstOrg.globalToolPolicy,
    discoveredToolPolicy: firstOrg.discoveredToolPolicy,
  };
}

export async function getGlobalToolPolicy(
  agentId: string,
): Promise<GlobalToolPolicy> {
  return (await getToolPolicies(agentId)).globalToolPolicy;
}

function buildToolInvocationPolicyBlockResult(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  reason: string;
  allToolCallNames?: string[];
}): PolicyBlockResult {
  const toolArguments = JSON.stringify(params.toolInput);
  const archestraMetadata = buildArchestraToolRefusalMetadata({
    toolName: params.toolName,
    toolArguments,
    reason: params.reason,
  });

  const contentMessage = `
I tried to invoke the ${params.toolName} tool with the following arguments: ${toolArguments}.

However, I was denied by a tool invocation policy:

${params.reason}`;

  return {
    refusalMessage: `${archestraMetadata}
${contentMessage}`,
    contentMessage,
    reason: params.reason,
    blockedToolName: params.toolName,
    allToolCallNames: params.allToolCallNames ?? [params.toolName],
  };
}
