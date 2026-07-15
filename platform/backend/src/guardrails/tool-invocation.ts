import {
  buildPolicyDeniedMcpToolError,
  buildToolInvocationRefusalMessages,
  isAgentTool,
  type PolicyDeniedMcpToolError,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON,
  type ToolInvocationEnforcementSurface,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { disabledToolsNotRunMessage } from "@/archestra-mcp-server/tool-recovery-messages";
import logger from "@/logging";
import { AgentTeamModel, ToolInvocationPolicyModel, ToolModel } from "@/models";
import type { PolicyEvaluationContext } from "@/models/tool-invocation-policy";

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
  /** The id of the tool row the policy was evaluated against, when known. */
  blockedToolId?: string;
  /** The blocked tool's arguments, carried into the structured tool error */
  toolInput: Record<string, unknown>;
  /** All tool call names in the batch (all are blocked when any one is) */
  allToolCallNames: string[];
}

/**
 * Where the block happened and how to reference it, for the client-visible
 * message ("<Product> LLM Proxy blocked…" vs "<Product> MCP Gateway blocked…").
 */
export interface PolicyEnforcementContext {
  surface: ToolInvocationEnforcementSurface;
  sessionId?: string;
}

/**
 * The machine-readable tool error for a policy block. Gateway and run_tool
 * results attach this to `_meta`/`structuredContent` so clients parse the block
 * structurally instead of scraping the prose.
 */
export function policyBlockToToolError(
  policyBlock: PolicyBlockResult,
  policyUrl?: string,
): PolicyDeniedMcpToolError {
  return buildPolicyDeniedMcpToolError({
    toolName: policyBlock.blockedToolName,
    toolId: policyBlock.blockedToolId,
    input: policyBlock.toolInput,
    reason: policyBlock.reason,
    message: policyBlock.contentMessage,
    policyUrl,
  });
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
  /**
   * The id of the tool row the gateway resolved to execute. When supplied, the
   * policy is evaluated against this exact row (instead of a name lookup) and
   * the id rides along on the structured block so the chat "Edit policy" modal
   * can resolve the tool even when it has no agent_tools assignment (Auto mode).
   */
  resolvedToolId?: string;
}): Promise<PolicyBlockResult | null> {
  // Policy-bypassing built-ins and agent delegation tools are always allowed.
  // Policy-evaluated built-ins like query_knowledge_sources fall through so
  // their invocation policies are enforced on the gateway execution path too.
  if (
    archestraMcpBranding.isPolicyBypassedToolName(params.toolName) ||
    isAgentTool(params.toolName)
  ) {
    return null;
  }

  const [teamIds, enabledToolNames] = await Promise.all([
    AgentTeamModel.getTeamsForAgent(params.agentId),
    params.enabledToolNames ?? ToolModel.getAssignedToolNames(params.agentId),
  ]);
  const policyContext = {
    teamIds,
    externalAgentId: params.externalAgentId,
  };

  // Resolve the row that will execute (dynamic id if supplied, else the assigned
  // row via the execution resolver) so policy evaluation and the approval check
  // both act on that exact row when a name is shared by duplicate rows.
  const resolvedToolId =
    params.resolvedToolId ??
    (
      await ToolModel.getAssignedToolIdsByName(
        [params.toolName],
        params.agentId,
      )
    ).get(params.toolName);

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
    MCP_GATEWAY_ENFORCEMENT,
    resolvedToolId ? new Map([[params.toolName, resolvedToolId]]) : undefined,
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
      resolvedToolId,
    );
  if (!requiresApproval) {
    return null;
  }

  return buildToolInvocationPolicyBlockResult({
    toolName: params.toolName,
    toolId: resolvedToolId,
    toolInput: params.toolInput,
    reason: TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
    enforcement: MCP_GATEWAY_ENFORCEMENT,
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
 * @param enforcement - Which surface is blocking (for message attribution) and
 *                      the session id to reference; defaults to the LLM proxy.
 */
export const evaluatePolicies = async (
  toolCalls: Array<{ toolCallName: string; toolCallArgs: string }>,
  agentId: string,
  context: PolicyEvaluationContext,
  contextIsTrusted: boolean,
  enabledToolNames: Set<string>,
  enforcement: PolicyEnforcementContext = { surface: "llm-proxy" },
  resolvedToolIdByName?: Map<string, string>,
): Promise<PolicyBlockResult | null> => {
  logger.debug(
    {
      agentId,
      toolCallCount: toolCalls.length,
      contextIsTrusted,
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
      toolInput: {},
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
  const { isAllowed, reason, toolCallName, toolId } =
    await ToolInvocationPolicyModel.evaluateBatch(
      agentId,
      parsedToolCalls,
      context,
      contextIsTrusted,
      resolvedToolIdByName,
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
      toolId,
      toolInput,
      reason,
      allToolCallNames: filteredToolCalls.map((tc) => tc.toolCallName),
      enforcement,
    });
  }

  logger.debug(
    { agentId, toolCallCount: toolCalls.length },
    "[toolInvocation] evaluatePolicies: all tool calls allowed",
  );
  return null;
};

const MCP_GATEWAY_ENFORCEMENT: PolicyEnforcementContext = {
  surface: "mcp-gateway",
};

function buildToolInvocationPolicyBlockResult(params: {
  toolName: string;
  toolId?: string;
  toolInput: Record<string, unknown>;
  reason: string;
  enforcement: PolicyEnforcementContext;
  allToolCallNames?: string[];
}): PolicyBlockResult {
  const { contentMessage, refusalMessage } = buildToolInvocationRefusalMessages(
    {
      toolName: params.toolName,
      toolArguments: JSON.stringify(params.toolInput),
      reason: params.reason,
      surface: params.enforcement.surface,
      sessionId: params.enforcement.sessionId,
      productName: archestraMcpBranding.catalogName,
    },
  );

  return {
    refusalMessage,
    contentMessage,
    reason: params.reason,
    blockedToolName: params.toolName,
    blockedToolId: params.toolId,
    toolInput: params.toolInput,
    allToolCallNames: params.allToolCallNames ?? [params.toolName],
  };
}
