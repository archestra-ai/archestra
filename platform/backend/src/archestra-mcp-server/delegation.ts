import {
  ADVISOR_DELEGATION_GUIDANCE,
  AGENT_TOOL_PREFIX,
  BUILT_IN_AGENT_IDS,
  slugify,
} from "@archestra/shared";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { DelegationLoopError } from "@/agents/errors";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { startDelegatedTask } from "@/archestra-mcp-server/tasks";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import {
  AgentExcludedSubagentModel,
  AgentModel,
  AgentTeamModel,
  ToolModel,
} from "@/models";
import { ProviderError, SubagentProviderError } from "@/routes/chat/errors";
import { resolveAgentDeployment } from "@/services/runners/pod-execution";
import type { Agent } from "@/types";
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
  // targets are advertised. The advisor is the one exception — its org-wide
  // (env-less) row is reachable from every environment.
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
  // the calling agent's environment (advisor excepted).
  const allToolsWithDetails = (
    await ToolModel.getDelegationToolsByAgent(agentId)
  ).filter((t) => isReachableDelegationTarget(t.targetAgent, environmentId));

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
  // crosses environment boundaries, advisor excepted.
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

  // Background execution is a capability of the target Agent, not a separate
  // invocation syntax. The ordinary agent__* delegation tool therefore turns
  // into a detached durable task whenever that target has a deployment. A
  // direct conversation with the same Agent never enters this path and stays
  // in the foreground loop.
  const targetAgent = await AgentModel.findById(target.id);
  if (targetAgent && resolveAgentDeployment(targetAgent)) {
    logger.info(
      {
        agentId,
        targetAgentId: target.id,
        targetAgentName: target.name,
        organizationId,
        userId: userId || "system",
      },
      "Starting background task from agent delegation",
    );
    return startDelegatedTask({
      agentId: target.id,
      message,
      context,
    });
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
      // The advisor's row is env-less, so the executor needs the caller's
      // environment to bill the consultation to it.
      callerEnvironmentId: environmentId,
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
    // Re-throw provider failures so they propagate to the parent stream's
    // onError with the correct provider info (the subagent can't produce
    // output). Preserve the deepest origin when subagents delegate again.
    if (error instanceof ProviderError) {
      if (error instanceof SubagentProviderError) {
        throw error;
      }
      throw new SubagentProviderError({
        providerError: error,
        subagentId: target.id,
        subagentName: target.name,
      });
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
      organizationId,
      excludeAgentId: agentId,
      environmentId,
    }),
    AgentExcludedSubagentModel.findTargetAgentIdsByAgent(agentId),
  ]);

  const excluded = new Set(excludedIds);
  const seenNames = new Set<string>();
  const tools: Tool[] = [];

  for (const targetAgent of preferAdvisorOnSlugTies(targets)) {
    if (excluded.has(targetAgent.id)) {
      continue;
    }
    const name = `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`;
    // Two agents can slugify to the same tool name; keep the first (targets
    // share preferAdvisorOnSlugTies's order with dispatch) so the advertised
    // name resolves deterministically.
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
      organizationId,
      excludeAgentId: agentId,
      environmentId,
    }),
    AgentExcludedSubagentModel.findTargetAgentIdsByAgent(agentId),
  ]);

  const excluded = new Set(excludedIds);
  const match = preferAdvisorOnSlugTies(targets).find(
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
      isReachableDelegationTarget(d.targetAgent, environmentId) &&
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

/**
 * Delegation never crosses environment boundaries, with one exception: the
 * advisor's org-wide row is reachable from every environment. The exception is
 * pinned to `environmentId === null` so only the genuine env-less advisor
 * crosses — an environment-scoped row carrying the advisor discriminator (stray
 * residue) stays fenced to its own environment.
 */
function isReachableDelegationTarget(
  targetAgent: {
    environmentId: string | null;
    builtInAgentConfig: Agent["builtInAgentConfig"];
  },
  environmentId: string | null,
): boolean {
  if (targetAgent.environmentId === environmentId) {
    return true;
  }
  return (
    targetAgent.environmentId === null &&
    targetAgent.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.ADVISOR
  );
}

/**
 * Deterministic Auto-mode ordering shared by the surface builder and dispatch:
 * slug order, with the built-in advisor winning any slug tie. A user agent
 * named "Advisor" in any environment collides with the built-in on
 * `agent__advisor`; the built-in wins, and both dedup (first-wins) and
 * `.find()` dispatch read this order so they never disagree.
 */
function preferAdvisorOnSlugTies<
  T extends Pick<Agent, "id" | "name" | "builtInAgentConfig">,
>(targets: T[]): T[] {
  return [...targets].sort((a, b) => {
    const slugA = slugify(a.name);
    const slugB = slugify(b.name);
    if (slugA !== slugB) return slugA < slugB ? -1 : 1;
    const advisorA = a.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.ADVISOR;
    const advisorB = b.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.ADVISOR;
    if (advisorA !== advisorB) return advisorA ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

function noDelegationConfiguredError(targetAgentSlug: string): CallToolResult {
  return errorResult(
    `No delegation is configured for "${AGENT_TOOL_PREFIX}${targetAgentSlug}". Use an exact agent delegation tool name (${AGENT_TOOL_PREFIX}*) from your tools list. Do not guess delegation names.`,
  );
}

function buildDelegationToolDescriptor(params: {
  name: string;
  targetAgent: {
    id: string;
    name: string;
    description?: string | null;
    builtInAgentConfig?: Agent["builtInAgentConfig"];
  };
  inputSchema: Tool["inputSchema"];
}): Tool {
  const { name, targetAgent, inputSchema } = params;
  // The advisor answers with shipped guidance rather than the administrator's
  // description: that field is a one-line summary written for a person, while
  // the calling model needs the cases where consulting pays for itself. Being
  // ours, it is not truncated the way a user-authored description is.
  const description =
    targetAgent.builtInAgentConfig?.name === BUILT_IN_AGENT_IDS.ADVISOR
      ? archestraMcpBranding.brandBuiltInText(ADVISOR_DELEGATION_GUIDANCE)
      : targetAgent.description
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
