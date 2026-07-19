import { AGENT_TOOL_PREFIX, slugify } from "@archestra/shared";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { DelegationLoopError } from "@/agents/errors";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import {
  AgentExcludedSubagentModel,
  AgentModel,
  AgentTeamModel,
  ToolModel,
} from "@/models";
import { ProviderError } from "@/routes/chat/errors";
import { errorResult, isAbortLikeError, successResult } from "./helpers";
import type { ArchestraContext } from "./types";

export const delegationToolArgsSchema = z.object({
  message: z.string().trim().min(1, "message is required."),
});

// The canonical delegation input schema, reused for Auto-mode synthesized
// delegation tools so they are indistinguishable from explicit ones.
const DELEGATION_INPUT_JSON_SCHEMA = z.toJSONSchema(delegationToolArgsSchema, {
  io: "input",
}) as Tool["inputSchema"];

// === Exports ===

/**
 * Get agent delegation tools for an agent. Each eligible target agent becomes a
 * separate tool (e.g. `agent__research_bot`). Two modes, mirroring the Auto/
 * Custom tool pattern:
 *
 * - **Auto** (`agents.access_all_subagents`, real user only): every internal
 *   agent the calling user can access (minus per-agent exclusions), resolved
 *   dynamically — explicit delegation rows are irrelevant, exactly like Auto
 *   tool mode ignores assignments.
 * - **Custom** (default, and every non-user/system flow): only the explicitly-
 *   configured delegation targets, filtered by the caller's agent access.
 *
 * Note: Agent delegation tools are separate from Archestra tools.
 */
export async function getAgentTools(context: {
  agentId: string;
  organizationId: string;
  userId?: string;
  /** Skip user access check (for A2A/ChatOps flows where caller has elevated permissions) */
  skipAccessCheck?: boolean;
}): Promise<Tool[]> {
  const { agentId, organizationId, userId, skipAccessCheck } = context;

  // Delegation never crosses environment boundaries (null is the Default
  // environment), mirroring tool isolation: in both modes only same-environment
  // targets are advertised.
  const environmentId = await AgentModel.findEnvironmentId(agentId);

  // Auto mode only expands for a real authenticated user; system/token flows
  // (chatops, scheduled triggers, A2A) fall back to explicit delegations. This
  // fail-closed gate mirrors the Auto-tool `dynamicAccessContext` gate.
  const isRealUser = Boolean(userId) && userId !== "system";
  if (isRealUser && (await AgentModel.getAccessAllSubagents(agentId))) {
    return buildAutoDelegationTools({
      agentId,
      organizationId,
      // biome-ignore lint/style/noNonNullAssertion: isRealUser guarantees userId
      userId: userId!,
      environmentId,
    });
  }

  // Custom mode: only explicitly-configured delegation targets, restricted to
  // the calling agent's environment.
  const allToolsWithDetails = (
    await ToolModel.getDelegationToolsByAgent(agentId)
  ).filter((t) => t.targetAgent.environmentId === environmentId);

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
  return accessibleTools.map((t) =>
    buildDelegationToolDescriptor({
      name: t.tool.name,
      targetAgent: t.targetAgent,
      inputSchema: t.tool.parameters as Tool["inputSchema"],
    }),
  );
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

  // The caller user can be present even when the selected gateway token is
  // team/org scoped.
  const userId = context.userId ?? tokenAuth?.userId;
  const isRealUser = Boolean(userId) && userId !== "system";

  // Same environment restriction as the advertised surface: delegation never
  // crosses environment boundaries.
  const environmentId = await AgentModel.findEnvironmentId(agentId);

  // Resolve the delegation target, mirroring getAgentTools: Auto mode resolves
  // dynamically against the caller-accessible set (minus exclusions); Custom
  // mode resolves against explicit delegation rows. Keeping resolution symmetric
  // with the advertised surface means a caller can only dispatch what it saw.
  const target =
    isRealUser && (await AgentModel.getAccessAllSubagents(agentId))
      ? await resolveAutoDelegationTarget({
          agentId,
          organizationId,
          // biome-ignore lint/style/noNonNullAssertion: isRealUser guarantees userId
          userId: userId!,
          environmentId,
          targetAgentSlug,
        })
      : await resolveExplicitDelegationTarget({
          agentId,
          organizationId,
          userId,
          environmentId,
          targetAgentSlug,
        });

  if ("error" in target) {
    return target.error;
  }

  // The caller's ancestor path, which the executor checks for cycles. A root
  // caller carries no chain yet, so it is the first hop.
  const parentDelegationChain = context.delegationChain || context.agentId;

  try {
    // Use sessionId from context, or fall back to the conversation/execution
    // scope so delegated requests still group together in logs
    const sessionId =
      context.sessionId || context.conversationId || context.isolationKey;

    logger.info(
      {
        agentId,
        targetAgentId: target.id,
        targetAgentName: target.name,
        organizationId,
        userId: userId || "system",
        sessionId,
      },
      "Executing agent delegation tool",
    );

    const result = await executeA2AMessage({
      agentId: target.id,
      message,
      organizationId,
      userId: userId || "system",
      sessionId,
      // Pass the current delegation chain so the child can extend it
      parentDelegationChain,
      // Propagate the real conversation id (absent in headless executions) and
      // the isolation scope separately: the child must never mistake an
      // execution key for a persisted conversation.
      conversationId: context.conversationId,
      isolationKey: context.isolationKey,
      chatOpsBindingId: context.chatOpsBindingId,
      chatOpsThreadId: context.chatOpsThreadId,
      scheduleTriggerRunId: context.scheduleTriggerRunId,
      abortSignal: context.abortSignal,
      // We only need to propagate whether the parent was already unsafe at the
      // delegation boundary. The child re-evaluates its own tool results and
      // records its own unsafe boundary instead of inheriting the parent's.
      parentContextIsTrusted: context.contextIsTrusted,
      // Surface the child's tool calls on the caller's conversation, attributed
      // to this delegation call. The shared bridge is threaded into the child
      // run so deeper descendants surface too.
      subagentToolStream: context.subagentToolStream,
      delegationToolCallId: context.currentToolCallId,
    });

    return successResult(result.text);
  } catch (error) {
    if (isAbortLikeError(error)) {
      logger.info(
        { agentId, targetAgentId: target.id },
        "Agent delegation was aborted",
      );
      throw error;
    }
    if (error instanceof DelegationLoopError) {
      logger.info(
        {
          agentId,
          targetAgentId: target.id,
          parentDelegationChain,
        },
        "Agent delegation refused to avoid a delegation loop",
      );
      return errorResult(error.message);
    }
    logger.error(
      { error, agentId, targetAgentId: target.id },
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

// === Internal ===

type ResolvedTarget = { id: string; name: string } | { error: CallToolResult };

/**
 * Build the Auto-mode delegation surface: every accessible internal agent minus
 * per-agent exclusions, deduped by slug (first wins, matching dispatch's
 * `.find()` semantics so the surface and dispatch never disagree).
 */
async function buildAutoDelegationTools(params: {
  agentId: string;
  organizationId: string;
  userId: string;
  environmentId: string | null;
}): Promise<Tool[]> {
  const { agentId, organizationId, userId, environmentId } = params;

  const isAgentAdmin = await userHasPermission(
    userId,
    organizationId,
    "agent",
    "admin",
  );

  const [targets, excludedIds] = await Promise.all([
    AgentModel.findAccessibleDelegationTargets({
      userId,
      isAdmin: isAgentAdmin,
      excludeAgentId: agentId,
      environmentId,
    }),
    AgentExcludedSubagentModel.findTargetAgentIdsByAgent(agentId),
  ]);

  const excluded = new Set(excludedIds);
  const seenNames = new Set<string>();
  const tools: Tool[] = [];

  for (const targetAgent of targets) {
    if (excluded.has(targetAgent.id)) {
      continue;
    }
    const name = `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`;
    // Two agents can slugify to the same tool name; keep the first (targets are
    // name-ordered) so the advertised name resolves deterministically.
    if (seenNames.has(name)) {
      continue;
    }
    seenNames.add(name);
    tools.push(
      buildDelegationToolDescriptor({
        name,
        targetAgent,
        inputSchema: DELEGATION_INPUT_JSON_SCHEMA,
      }),
    );
  }

  logger.debug(
    {
      agentId,
      organizationId,
      userId,
      accessibleTargetCount: targets.length,
      excludedCount: excluded.size,
      exposedToolCount: tools.length,
    },
    "Built Auto-mode agent delegation tools",
  );

  return tools;
}

/**
 * Auto-mode dispatch resolution: find the caller-accessible, non-excluded target
 * whose slug matches, using the same name-ordering/first-match rule as the
 * surface builder.
 */
async function resolveAutoDelegationTarget(params: {
  agentId: string;
  organizationId: string;
  userId: string;
  environmentId: string | null;
  targetAgentSlug: string;
}): Promise<ResolvedTarget> {
  const { agentId, organizationId, userId, environmentId, targetAgentSlug } =
    params;

  const isAgentAdmin = await userHasPermission(
    userId,
    organizationId,
    "agent",
    "admin",
  );

  const [targets, excludedIds] = await Promise.all([
    AgentModel.findAccessibleDelegationTargets({
      userId,
      isAdmin: isAgentAdmin,
      excludeAgentId: agentId,
      environmentId,
    }),
    AgentExcludedSubagentModel.findTargetAgentIdsByAgent(agentId),
  ]);

  const excluded = new Set(excludedIds);
  const match = targets.find(
    (t) => !excluded.has(t.id) && slugify(t.name) === targetAgentSlug,
  );

  if (!match) {
    return { error: noDelegationConfiguredError(targetAgentSlug) };
  }

  return { id: match.id, name: match.name };
}

/**
 * Custom-mode dispatch resolution: match an explicitly-configured delegation
 * row by slug and enforce the caller's agent access.
 */
async function resolveExplicitDelegationTarget(params: {
  agentId: string;
  organizationId: string;
  userId: string | undefined;
  environmentId: string | null;
  targetAgentSlug: string;
}): Promise<ResolvedTarget> {
  const { agentId, organizationId, userId, environmentId, targetAgentSlug } =
    params;

  const delegations = await ToolModel.getDelegationToolsByAgent(agentId);
  const delegation = delegations.find(
    (d) =>
      d.targetAgent.environmentId === environmentId &&
      slugify(d.targetAgent.name) === targetAgentSlug,
  );

  if (!delegation) {
    return { error: noDelegationConfiguredError(targetAgentSlug) };
  }

  // Check user access when a real caller is available. The caller user can be
  // present even when the selected gateway token is team/org scoped.
  if (userId && userId !== "system") {
    const isAgentAdmin = await userHasPermission(
      userId,
      organizationId,
      "agent",
      "admin",
    );

    const userAccessibleAgentIds =
      await AgentTeamModel.getUserAccessibleAgentIds(userId, isAgentAdmin);
    if (!userAccessibleAgentIds.includes(delegation.targetAgent.id)) {
      return { error: errorResult("You don't have access to this agent.") };
    }
  }

  return { id: delegation.targetAgent.id, name: delegation.targetAgent.name };
}

function noDelegationConfiguredError(targetAgentSlug: string): CallToolResult {
  return errorResult(
    `No delegation is configured for "${AGENT_TOOL_PREFIX}${targetAgentSlug}". Use an exact agent delegation tool name (${AGENT_TOOL_PREFIX}*) from your tools list. Do not guess delegation names.`,
  );
}

function buildDelegationToolDescriptor(params: {
  name: string;
  targetAgent: { id: string; name: string; description?: string | null };
  inputSchema: Tool["inputSchema"];
}): Tool {
  const { name, targetAgent, inputSchema } = params;
  const description = targetAgent.description
    ? `Delegate task to agent: ${targetAgent.name}. ${targetAgent.description.substring(0, 400)}`
    : `Delegate task to agent: ${targetAgent.name}`;

  return {
    name,
    title: targetAgent.name,
    description,
    inputSchema,
    annotations: {},
    _meta: { targetAgentId: targetAgent.id },
  };
}
