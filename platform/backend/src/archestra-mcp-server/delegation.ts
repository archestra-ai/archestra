import {
  AGENT_TOOL_PREFIX,
  LOAD_BALANCED_RUNTIME_ROUTER_META_KEY,
  type ModelSelection,
  normalizeSubagentLoadBalancingConfig,
  SELF_FORK_TOOL_NAME,
  SubagentModelTierSchema,
  slugify,
} from "@archestra/shared";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { convertToModelMessages, type ModelMessage } from "ai";
import { z } from "zod";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { DelegationLoopError } from "@/agents/errors";
import { availableSubagentTiers, type ForkTier } from "@/agents/subagent-tiers";
import { startDelegatedTask } from "@/archestra-mcp-server/tasks";
import type { RequestLookups } from "@/auth/request-lookups";
import logger from "@/logging";
import {
  A2aConnectionModel,
  AgentExcludedSubagentModel,
  AgentModel,
  AgentTeamModel,
  ToolModel,
} from "@/models";
import ResourcePermissionSubjectModel from "@/models/resource-permission-subject";
import {
  loadChildReturns,
  loadDeferredReturn,
  startRuntimeChild,
  withCapturedGuardrailsActivation,
} from "@/openappa/service";
import {
  mintSubagentBinding,
  type SubagentBinding,
  subagentReturnPrefix,
} from "@/openappa/subagent-binding";
import { ProviderError, SubagentProviderError } from "@/routes/chat/errors";
import {
  type A2AOAuthExecution,
  authorizeA2AOAuthExecution,
} from "@/routes/mcp-gateway/utils";
import { executeOutboundA2aDelegation } from "@/services/a2a-outbound-client";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import {
  promptWithContract,
  SPAWN_TARGET_MISMATCH,
} from "@/services/agent-runtime/runtime-crossing";
import {
  callerUsesImplicitLoadBalancedRunStarter,
  resolveRouterRuntimePoolCandidateIds,
} from "@/services/agent-subagent-exclusions";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import { ResourcePermissions } from "@/services/resource-permissions";
import { type Agent, ApiError } from "@/types";
import { resolveForkParentSelection } from "@/utils/llm-resolution";
import { errorResult, isAbortLikeError, successResult } from "./helpers";
import type { ArchestraContext } from "./types";

export const delegationToolArgsSchema = z.object({
  message: z.string().trim().min(1, "message is required."),
  runtime_proof: z
    .string()
    .optional()
    .describe("Source-session proof supplied by the proxy."),
});

// The canonical delegation input schema, reused for Auto-mode synthesized
// delegation tools so they are indistinguishable from explicit ones.
const DELEGATION_INPUT_JSON_SCHEMA = z.toJSONSchema(delegationToolArgsSchema, {
  io: "input",
}) as Tool["inputSchema"];

export const selfForkToolArgsSchema = delegationToolArgsSchema.extend({
  tier: SubagentModelTierSchema.optional(),
});

/**
 * The fork's input schema. `tier` is advertised only with the tiers that would
 * move the copy to another model; with none it is left out entirely.
 */
function selfForkInputSchema(tiers: ForkTier[]): Tool["inputSchema"] {
  if (tiers.length === 0) return DELEGATION_INPUT_JSON_SCHEMA;
  const descriptions = {
    smart:
      "`smart`: a stronger model, for hard reasoning or checking a conclusion.",
    fast: "`fast`: a cheaper, quicker model, for bulk reading, searching, or extraction.",
  };
  return {
    ...DELEGATION_INPUT_JSON_SCHEMA,
    properties: {
      ...DELEGATION_INPUT_JSON_SCHEMA.properties,
      tier: {
        type: "string",
        enum: ["normal", ...tiers],
        description: [
          "Model the copy runs on.",
          ...tiers.map((tier) => descriptions[tier]),
          "`normal` (default): your own model.",
        ].join(" "),
      },
    },
  };
}

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
  lookups?: RequestLookups;
  /** The model and key the caller runs on, which its fork starts from. */
  parentLlm?: ModelSelection;
  /** The caller's own delegation chain; a fork's ends in its agent twice. */
  delegationChain?: string;
  oauthExecution?: A2AOAuthExecution;
  /** Whether the caller is a machine OAuth application barred from Agent Runtime. */
  disallowOAuthApp?: boolean;
}): Promise<Tool[]> {
  const { agentId, organizationId, userId, skipAccessCheck, lookups } = context;

  // Delegation never crosses environment boundaries (null is the Default
  // environment), mirroring tool isolation: in both modes only same-environment
  // targets are advertised.
  const callerGatewayAgent = lookups
    ? await lookups.gatewayAgent(agentId)
    : await AgentModel.findGatewayAgentById(agentId);
  const environmentId = callerGatewayAgent
    ? callerGatewayAgent.environmentId
    : await AgentModel.findEnvironmentId(agentId);
  // External A2A targets are always explicit, including when local subagents
  // use Auto mode. Assigning an external credential is an egress decision and
  // must never be widened by a dynamic local-agent setting.
  // External A2A currently executes from the backend process, outside the
  // per-environment network-policy runtime. Fail closed for environment-bound
  // agents until connections can be bound to and dialed through that runtime.
  const realUserId = userId && userId !== "system" ? userId : undefined;
  const runtimeCapableActor = hasRuntimeCapableDelegationActor({
    realUserId,
    oauthExecution: context.oauthExecution,
    disallowOAuthApp: context.disallowOAuthApp,
  });
  // Hide individual `agent__<runtime_worker>` schemas only when the canonical
  // `start_agent_run` pooled starter is actually exposed and RBAC-permitted for
  // this caller (load balancing enabled, acting user has `agent:read`,
  // `start_agent_run` not excluded in Auto-tools mode, and >=1 candidate
  // runtime subagent). If `start_agent_run` is excluded or RBAC-denied, keep
  // `agent__<runtime_worker>` tools visible so the caller retains a way to
  // launch runtime work.
  const hideRuntimeWorkerTools =
    callerGatewayAgent != null &&
    runtimeCapableActor &&
    (await callerUsesImplicitLoadBalancedRunStarter({
      agent: callerGatewayAgent,
      actorUserId: realUserId,
      lookups,
      disallowOAuthApp: context.disallowOAuthApp,
    }));
  const attestable = await isGuardrailsV2Active();
  const outboundTargets = environmentId
    ? []
    : await A2aConnectionModel.findAssignedTargets(
        agentId,
        organizationId,
        false,
        realUserId ? { userId: realUserId, lookups } : undefined,
      );
  const outboundTools = outboundTargets.map((target) =>
    buildDelegationToolDescriptor({
      name: target.tool.name,
      targetAgent: target.remoteAgent,
      inputSchema: target.tool.parameters as Tool["inputSchema"],
      externalA2a: true,
      toolId: target.tool.id,
    }),
  );

  // Auto mode only expands for a real authenticated user; system/token flows
  // (chatops, scheduled triggers, A2A) fall back to explicit delegations. This
  // fail-closed gate mirrors the Auto-tool `dynamicAccessContext` gate.
  if (
    realUserId &&
    (callerGatewayAgent
      ? callerGatewayAgent.accessAllSubagents
      : await AgentModel.getAccessAllSubagents(agentId))
  ) {
    const localTools = await buildAutoDelegationTools({
      agentId,
      organizationId,
      userId: realUserId,
      environmentId,
      attestable,
      hideRuntimeWorkerTools,
      runtimeCapableActor,
    });
    return finishDelegationTools(
      context,
      [...outboundTools, ...localTools],
      attestable,
    );
  }

  // Custom mode: only explicitly-configured delegation targets, restricted to
  // the calling agent's environment.
  const allToolsWithDetails = (
    await ToolModel.getDelegationToolsByAgent(agentId)
  ).filter((t) => isReachableDelegationTarget(t.targetAgent, environmentId));

  // Filter by user access if user ID is provided (skip for A2A/ChatOps flows)
  let accessibleTools = allToolsWithDetails;
  let resolvedIsAgentAdmin: boolean | undefined;
  if (userId && !skipAccessCheck) {
    // Check if user has agent admin permission directly (don't trust caller)
    const isAgentAdmin = await ResourcePermissions.allows({
      userId: userId,
      organizationId: organizationId,
      resource: "agent",
      scope: "*",
      action: "update",
      lookups,
    });
    resolvedIsAgentAdmin = isAgentAdmin;

    const userAccessibleAgentIds =
      await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        isAgentAdmin,
        lookups &&
          (await ResourcePermissionSubjectModel.resolvePrincipals({
            userId,
            lookups,
          })),
      );
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

  const visibleTools = hideRuntimeWorkerTools
    ? accessibleTools.filter((t) => !t.targetAgent.hasRuntime)
    : accessibleTools;
  const routerMetadata =
    runtimeCapableActor && realUserId
      ? await resolveLoadBalancedRouterPools({
          callerAgentId: agentId,
          organizationId,
          actorUserId: realUserId,
          actorIsAgentAdmin:
            realUserId === userId ? resolvedIsAgentAdmin : undefined,
          skipAccessCheck,
          targets: visibleTools.map((t) => ({
            id: t.targetAgent.id,
            name: t.targetAgent.name,
            toolName: t.tool.name,
            hasRuntime: t.targetAgent.hasRuntime,
            hasSubagentLoadBalancing: t.targetAgent.hasSubagentLoadBalancing,
          })),
        })
      : EMPTY_ROUTER_POOL_METADATA;

  // Convert DB tools to MCP Tool format
  const localTools = visibleTools.map((t) =>
    buildDelegationToolDescriptor({
      name: t.tool.name,
      targetAgent: t.targetAgent,
      inputSchema: t.tool.parameters as Tool["inputSchema"],
      attestable,
      routerPoolNames: routerMetadata.poolNamesByRouterId.get(t.targetAgent.id),
      managingRouters: routerMetadata.managingRoutersByWorkerId.get(
        t.targetAgent.id,
      ),
    }),
  );
  return finishDelegationTools(
    context,
    [...outboundTools, ...localTools],
    attestable,
  );
}

export async function handleDelegation(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult> {
  if (context.suppressContentLogging) {
    return errorResult("Agent delegation is not available in encrypted chats.");
  }

  const { agentId, organizationId, tokenAuth } = context;

  const message = args?.message as string;

  if (!message) {
    return errorResult("message is required.");
  }

  // Validated against the advertised schema at dispatch.
  const tier = SubagentModelTierSchema.optional().parse(args?.tier);

  if (!agentId) {
    return errorResult("No agent context available.");
  }

  if (!organizationId) {
    return errorResult("Organization context not available.");
  }

  const selfFork = toolName === SELF_FORK_TOOL_NAME;
  // Extract target agent slug from tool name
  const targetAgentSlug = toolName.replace(AGENT_TOOL_PREFIX, "");

  // The caller user can be present even when the selected gateway token is
  // team/org scoped.
  const userId = context.userId ?? tokenAuth?.userId;
  const realUserId = userId && userId !== "system" ? userId : undefined;

  const environmentId = await AgentModel.findEnvironmentId(agentId);

  const outboundTarget = selfFork
    ? undefined
    : await A2aConnectionModel.findAssignedTargetByToolName({
        agentId,
        organizationId,
        toolName,
        ...(realUserId ? { userId: realUserId } : {}),
      });
  if (outboundTarget) {
    if (context.openappaRuntimeCall?.spawn) {
      return errorResult(SPAWN_TARGET_MISMATCH);
    }
    if (environmentId) {
      return errorResult(
        "Outbound A2A delegation is not available for environment-bound agents yet.",
      );
    }
    try {
      const text = await executeOutboundA2aDelegation({
        target: outboundTarget,
        message,
        context,
      });
      return delegationResult(message, text);
    } catch (error) {
      if (isAbortLikeError(error)) throw error;
      return errorResult(
        error instanceof Error
          ? error.message
          : "Outbound A2A delegation failed",
      );
    }
  }

  // Same environment restriction as the advertised surface: delegation never
  // crosses environment boundaries.
  // Resolve the delegation target, mirroring getAgentTools: Auto mode resolves
  // dynamically against the caller-accessible set (minus exclusions); Custom
  // mode resolves against explicit delegation rows. Keeping resolution symmetric
  // with the advertised surface means a caller can only dispatch what it saw.
  const target = selfFork
    ? await resolveSelfForkTarget(agentId)
    : realUserId && (await AgentModel.getAccessAllSubagents(agentId))
      ? await resolveAutoDelegationTarget({
          agentId,
          organizationId,
          userId: realUserId,
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

  if (tokenAuth?.oauthExecution) {
    try {
      await authorizeA2AOAuthExecution({
        agentId: target.id,
        organizationId,
        execution: tokenAuth.oauthExecution,
      });
    } catch {
      return errorResult("Agent not found or not accessible.");
    }
  }

  // Agent Runtime is a capability of the target Agent, not a separate
  // invocation syntax. The ordinary agent__* delegation tool therefore turns
  // into a detached durable task whenever that target has a runtime or is a
  // foreground load-balanced router over runtime subagents (binding the
  // winning runtime child directly to the caller's session). A direct
  // conversation with the same Agent never enters this path and stays in the
  // foreground loop.
  // A fork is a copy of the running caller, so it always runs in this process.
  const disallowOAuthApp = Boolean(
    tokenAuth?.oauthClientId && !tokenAuth.isUserToken,
  );
  const runtimeCapableActor = hasRuntimeCapableDelegationActor({
    realUserId,
    oauthExecution: tokenAuth?.oauthExecution,
    disallowOAuthApp,
  });
  const targetAgent = await AgentModel.findById(target.id);
  const targetHasRuntime = Boolean(
    targetAgent && resolveAgentRuntime(targetAgent),
  );
  const targetRouterCandidateIds =
    !selfFork &&
    runtimeCapableActor &&
    targetAgent &&
    !targetHasRuntime &&
    normalizeSubagentLoadBalancingConfig(targetAgent.subagentLoadBalancing)
      ?.enabled === true
      ? await resolveRouterRuntimePoolCandidateIds({
          routerAgent: targetAgent,
          actorUserId: realUserId,
          callerAgentId: agentId,
        })
      : [];
  const targetIsLoadBalancedRouter = targetRouterCandidateIds.length > 0;
  if (
    !selfFork &&
    targetAgent &&
    (targetHasRuntime || targetIsLoadBalancedRouter)
  ) {
    // A deferred return is decided by the caller right after the subagent
    // stops, which a background run outlives.
    if (context.openappaRuntimeCall?.defersReturn) {
      return errorResult(DEFERRED_RETURN_TARGET_MISMATCH);
    }
    const callerAgent = await AgentModel.findById(agentId);
    const loadBalancingEnabled =
      normalizeSubagentLoadBalancingConfig(callerAgent?.subagentLoadBalancing)
        ?.enabled === true;
    logger.info(
      {
        agentId,
        targetAgentId: target.id,
        targetAgentName: target.name,
        targetIsLoadBalancedRouter,
        loadBalancingEnabled,
        organizationId,
        userId: userId || "system",
      },
      "Starting background task from agent delegation",
    );
    return startDelegatedTask({
      ...(loadBalancingEnabled && !targetIsLoadBalancedRouter
        ? {}
        : { agentId: target.id }),
      message,
      context: context.agent
        ? context
        : {
            ...context,
            agent: {
              id: agentId,
              name: callerAgent?.name ?? agentId,
            },
          },
    });
  }

  // The caller's ancestor path, which the executor checks for cycles. A root
  // caller carries no chain yet, so it is the first hop.
  const parentDelegationChain = context.delegationChain || context.agentId;

  // An OpenAPPA spawn opens the child's trajectory before it reads anything;
  // the child hears its return contract first and runs on that trajectory.
  const spawn = await bindSubagent({
    context,
    organizationId,
    agentId: target.id,
  });
  if ("refusal" in spawn) return errorResult(spawn.refusal);

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

    const run = {
      agentId: target.id,
      ...(selfFork
        ? { selfFork: true as const, parentLlm: context.parentLlm, tier }
        : {}),
      ...(spawn.binding ? { appaSubagent: spawn.binding.child } : {}),
      organizationId,
      userId: userId || "system",
      oauthExecution: tokenAuth?.oauthExecution,
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
      chatOpsPinnedAgentId: context.chatOpsPinnedAgentId,
      scheduleTriggerRunId: context.scheduleTriggerRunId,
      runId: context.runId,
      abortSignal: context.abortSignal,
      // Surface the child's tool calls on the caller's conversation, attributed
      // to this delegation call. The shared bridge is threaded into the child
      // run so deeper descendants surface too.
      subagentToolStream: context.subagentToolStream,
      delegationToolCallId: context.currentToolCallId,
    };
    const task =
      promptWithContract(
        message,
        spawn.binding?.contract ??
          (context.openappaRuntimeCall?.defersReturn
            ? DEFERRED_SUBAGENT_BRIEF
            : undefined),
      ) ?? message;
    if (!spawn.binding) {
      return delegationResult(
        message,
        (await executeA2AMessage({ ...run, message: task })).text,
      );
    }
    // A bound child's answer reaches the parent only as the bytes its turn
    // crossed at its end; what it said otherwise stays with the child. A held
    // answer goes back to the same child, with everything it already read,
    // to be revised against the reason it was held.
    let history: ModelMessage[] = [];
    let turn = task;
    for (let attempt = 0; attempt <= SUBAGENT_RETURN_REVISIONS; attempt++) {
      const result = await executeA2AMessage({
        ...run,
        message: turn,
        ...(history.length > 0 ? { messages: history } : {}),
      });
      const admitted = await admittedSubagentReturn(spawn.binding.child);
      if (admitted !== undefined) return successResult(admitted);
      // The answer stays with the runtime until the caller decides; the
      // caller's next request reads the runtime's notice in place of this.
      if (
        context.openappaRuntimeCall?.defersReturn &&
        (await subagentReturnDeferred(context.openappaRuntimeCall))
      ) {
        return successResult(DEFERRED_SUBAGENT_RETURN);
      }
      history = [
        ...history,
        { role: "user", content: turn },
        ...(await convertToModelMessages([result.responseUiMessage])),
      ];
      turn = reviseHeldReturn(result.text);
    }
    return errorResult(WITHHELD_SUBAGENT_RETURN);
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

const SUBAGENT_RETURN_REVISIONS = 2;

function reviseHeldReturn(reason: string): string {
  return `Your final answer was not accepted, so it did not reach the agent that delegated this task:\n\n${reason}\n\nReply again with only a final answer that fits the declared return. Do not repeat work you already did.`;
}

const WITHHELD_SUBAGENT_RETURN =
  "The subagent ended without a final answer that may cross to this session, so its output was withheld. Delegate again with a task it can answer within the declared return.";

// Shown to the person in the conversation; the caller's model reads the
// runtime's notice in its place.
const DEFERRED_SUBAGENT_RETURN =
  "The subagent finished. Guardrails holds its answer until this agent accepts or discards it.";

const DEFERRED_SUBAGENT_BRIEF =
  "Guardrails notices you clear while working are not part of your answer: leave them out. Mention a notice only when what it blocked stayed blocked.";

const DEFERRED_RETURN_TARGET_MISMATCH =
  "This subagent now runs in the background, where this delegation's return cannot be decided. No task was delivered. Delegate again.";

type ResolvedTarget = { id: string; name: string } | { error: CallToolResult };

/** A fork runs the caller itself; nothing else may name it. */
async function resolveSelfForkTarget(agentId: string): Promise<ResolvedTarget> {
  const agent = await AgentModel.findDelegationTarget(agentId);
  if (!agent || agent.agentType !== "agent") {
    return { error: errorResult("Only an agent can fork itself.") };
  }
  return { id: agent.id, name: agent.name };
}

type SubagentSpawn =
  | { binding?: { child: SubagentBinding; contract?: string } }
  | { refusal: string };

/**
 * Binds the child trajectory an OpenAPPA spawn prepared for this delegation.
 * Delegations the proxy did not classify as a spawn run outside APPA, as
 * before. Refusal happens before the child reads anything.
 */
async function bindSubagent(params: {
  context: ArchestraContext;
  organizationId: string;
  agentId: string;
}): Promise<SubagentSpawn> {
  const call = params.context.openappaRuntimeCall;
  if (!call?.spawn || !(await isGuardrailsV2Active())) return {};
  if (call.session.organization_id !== params.organizationId) {
    return { refusal: "The source belongs to another organization." };
  }
  const child = mintSubagentBinding({
    agentId: params.agentId,
    parent: call.session,
    spawnCallId: call.toolCallId,
  });
  try {
    const { contract } = await startRuntimeChild({
      session: child.session,
      spawnCallId: call.toolCallId,
    });
    return { binding: { child, contract } };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    logger.info(
      { err: error, spawnCallId: call.toolCallId },
      "OpenAPPA could not bind the subagent's child trajectory",
    );
    return {
      refusal:
        "The subagent could not be started on a protected trajectory. No task was delivered.",
    };
  }
}

async function subagentReturnDeferred(
  spawn: NonNullable<ArchestraContext["openappaRuntimeCall"]>,
): Promise<boolean> {
  const notice = await withCapturedGuardrailsActivation("active", () =>
    loadDeferredReturn({
      session: spawn.session,
      spawnCallId: spawn.toolCallId,
    }),
  );
  return notice !== null;
}

async function admittedSubagentReturn(
  child: SubagentBinding,
): Promise<string | undefined> {
  const [latest] = await withCapturedGuardrailsActivation("active", () =>
    loadChildReturns({
      organizationId: child.session.organization_id,
      parentSessionId: child.session.parent_id,
      childSessionId: child.session.session_id,
      operationPrefix: subagentReturnPrefix(child.spawnCallId),
    }),
  );
  return latest?.value;
}

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
  attestable: boolean;
  hideRuntimeWorkerTools: boolean;
  runtimeCapableActor: boolean;
}): Promise<Tool[]> {
  const {
    agentId,
    organizationId,
    userId,
    environmentId,
    attestable,
    hideRuntimeWorkerTools,
    runtimeCapableActor,
  } = params;

  const isAgentAdmin = await ResourcePermissions.allows({
    userId: userId,
    organizationId: organizationId,
    resource: "agent",
    scope: "*",
    action: "update",
  });

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
  const dedupedTargets: Array<{
    name: string;
    targetAgent: (typeof targets)[number];
  }> = [];

  for (const targetAgent of sortDelegationTargets(targets)) {
    if (excluded.has(targetAgent.id)) {
      continue;
    }
    const name = `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`;
    // Two agents can slugify to the same tool name; keep the first (targets
    // share sortDelegationTargets's order with dispatch) so the advertised
    // name resolves deterministically.
    if (seenNames.has(name)) {
      continue;
    }
    seenNames.add(name);
    if (hideRuntimeWorkerTools && targetAgent.hasRuntime) {
      continue;
    }
    dedupedTargets.push({ name, targetAgent });
  }

  const routerMetadata = runtimeCapableActor
    ? await resolveLoadBalancedRouterPools({
        callerAgentId: agentId,
        organizationId,
        actorUserId: userId,
        actorIsAgentAdmin: isAgentAdmin,
        callerExcludedIds: excluded,
        targets: dedupedTargets.map(({ name, targetAgent }) => ({
          id: targetAgent.id,
          name: targetAgent.name,
          toolName: name,
          hasRuntime: targetAgent.hasRuntime,
          hasSubagentLoadBalancing: targetAgent.hasSubagentLoadBalancing,
        })),
      })
    : EMPTY_ROUTER_POOL_METADATA;

  const tools = dedupedTargets.map(({ name, targetAgent }) =>
    buildDelegationToolDescriptor({
      name,
      targetAgent,
      inputSchema: DELEGATION_INPUT_JSON_SCHEMA,
      attestable,
      routerPoolNames: routerMetadata.poolNamesByRouterId.get(targetAgent.id),
      managingRouters: routerMetadata.managingRoutersByWorkerId.get(
        targetAgent.id,
      ),
    }),
  );

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

  const isAgentAdmin = await ResourcePermissions.allows({
    userId: userId,
    organizationId: organizationId,
    resource: "agent",
    scope: "*",
    action: "update",
  });

  const [targets, excludedIds] = await Promise.all([
    AgentModel.findAccessibleDelegationTargets({
      userId,
      isAdmin: isAgentAdmin,
      organizationId,
      excludeAgentId: agentId,
      includeDetails: false,
      environmentId,
    }),
    AgentExcludedSubagentModel.findTargetAgentIdsByAgent(agentId),
  ]);

  const excluded = new Set(excludedIds);
  const match = sortDelegationTargets(
    targets.filter(
      (t) => !excluded.has(t.id) && slugify(t.name) === targetAgentSlug,
    ),
  )[0];

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
    const isAgentAdmin = await ResourcePermissions.allows({
      userId: userId,
      organizationId: organizationId,
      resource: "agent",
      scope: "*",
      action: "update",
    });

    const userAccessibleAgentIds =
      await AgentTeamModel.getUserAccessibleAgentIds(userId, isAgentAdmin);
    if (!userAccessibleAgentIds.includes(delegation.targetAgent.id)) {
      return { error: errorResult("You don't have access to this agent.") };
    }
  }

  return { id: delegation.targetAgent.id, name: delegation.targetAgent.name };
}

function isReachableDelegationTarget(
  targetAgent: {
    environmentId: string | null;
    builtInAgentConfig: Agent["builtInAgentConfig"];
  },
  environmentId: string | null,
): boolean {
  return targetAgent.environmentId === environmentId;
}

/** Stable slug ordering shared by tool advertisement and dispatch. */
function sortDelegationTargets<
  T extends Pick<Agent, "id" | "name" | "builtInAgentConfig">,
>(targets: T[]): T[] {
  return [...targets].sort((a, b) => {
    const slugA = slugify(a.name);
    const slugB = slugify(b.name);
    if (slugA !== slugB) return slugA < slugB ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

function noDelegationConfiguredError(targetAgentSlug: string): CallToolResult {
  return errorResult(
    `No delegation is configured for "${AGENT_TOOL_PREFIX}${targetAgentSlug}". Use an exact agent delegation tool name (${AGENT_TOOL_PREFIX}*) from your tools list. Do not guess delegation names.`,
  );
}

type RouterPoolReference = {
  routerName: string;
  routerToolName: string;
};

type RouterPoolMetadata = {
  poolNamesByRouterId: ReadonlyMap<string, string[]>;
  managingRoutersByWorkerId: ReadonlyMap<string, RouterPoolReference[]>;
};

const EMPTY_ROUTER_POOL_METADATA: RouterPoolMetadata = {
  poolNamesByRouterId: new Map(),
  managingRoutersByWorkerId: new Map(),
};

/**
 * Agent Runtime launches require a real user or service-account actor and are
 * disallowed for OAuth applications. Callers without a runtime-capable actor
 * (`"system"` sentinel turns, org/team gateway tokens without `userId`, and
 * OAuth application tokens) cannot launch runtime pools via `startDelegatedTask`,
 * so load-balanced router targets (`hasRuntime === false`) must stay on
 * synchronous in-process delegation (`executeA2AMessage`) and must not be
 * advertised as background runtime routers.
 */
function hasRuntimeCapableDelegationActor(params: {
  realUserId?: string;
  oauthExecution?: A2AOAuthExecution;
  disallowOAuthApp?: boolean;
}): boolean {
  return (
    Boolean(params.realUserId) &&
    !params.oauthExecution &&
    !params.disallowOAuthApp
  );
}

async function resolveLoadBalancedRouterPools(params: {
  callerAgentId: string;
  organizationId: string;
  actorUserId: string;
  actorIsAgentAdmin?: boolean;
  skipAccessCheck?: boolean;
  callerExcludedIds?: ReadonlySet<string>;
  targets: ReadonlyArray<{
    id: string;
    name: string;
    toolName: string;
    hasRuntime: boolean;
    hasSubagentLoadBalancing: boolean;
  }>;
}): Promise<RouterPoolMetadata> {
  const routerTargets = params.targets.filter(
    (target) => !target.hasRuntime && target.hasSubagentLoadBalancing,
  );
  if (routerTargets.length === 0) {
    return EMPTY_ROUTER_POOL_METADATA;
  }

  const [callerExcludedIds, routerConfigs] = await Promise.all([
    params.callerExcludedIds
      ? Promise.resolve(null)
      : AgentExcludedSubagentModel.findTargetAgentIdsByAgent(
          params.callerAgentId,
        ),
    AgentModel.findRouterPoolConfigsByOrganizationIdAndIds({
      organizationId: params.organizationId,
      agentIds: routerTargets.map((router) => router.id),
    }),
  ]);
  const callerExcludedSet =
    params.callerExcludedIds ?? new Set(callerExcludedIds ?? []);
  const routerConfigById = new Map(
    routerConfigs
      .filter(
        (cfg) =>
          normalizeSubagentLoadBalancingConfig(cfg.subagentLoadBalancing)
            ?.enabled === true,
      )
      .map((cfg) => [cfg.id, cfg] as const),
  );
  if (routerConfigById.size === 0) {
    return EMPTY_ROUTER_POOL_METADATA;
  }

  const nameByAgentId = new Map(
    params.targets.map((target) => [target.id, target.name] as const),
  );
  const autoRouterIds: string[] = [];
  const manualRouterIds: string[] = [];

  for (const router of routerTargets) {
    const cfg = routerConfigById.get(router.id);
    if (!cfg) continue;
    if (cfg.accessAllSubagents) {
      autoRouterIds.push(router.id);
    } else {
      manualRouterIds.push(router.id);
    }
  }

  const needsActorAccessLookup =
    autoRouterIds.length > 0 ||
    (!params.skipAccessCheck && manualRouterIds.length > 0);
  const isAgentAdmin = needsActorAccessLookup
    ? (params.actorIsAgentAdmin ??
      (await ResourcePermissions.allows({
        userId: params.actorUserId,
        organizationId: params.organizationId,
        resource: "agent",
        scope: "*",
        action: "update",
      })))
    : false;
  const filterManualByActorAccess = !params.skipAccessCheck && !isAgentAdmin;

  const accessibleEnvironmentKeys = new Map<string, string | null>();
  for (const router of routerTargets) {
    const cfg = routerConfigById.get(router.id);
    if (!cfg) continue;
    if (cfg.accessAllSubagents || filterManualByActorAccess) {
      const envKey = cfg.environmentId ?? "__default__";
      if (!accessibleEnvironmentKeys.has(envKey)) {
        accessibleEnvironmentKeys.set(envKey, cfg.environmentId);
      }
    }
  }

  const [
    assignedByManualRouter,
    autoExcludedByRouter,
    accessibleTargetsByEnvKey,
  ] = await Promise.all([
    manualRouterIds.length > 0
      ? AgentModel.findAssignedRuntimeSubagentIdsByAgents(manualRouterIds)
      : Promise.resolve(new Map<string, string[]>()),
    autoRouterIds.length > 0
      ? AgentExcludedSubagentModel.findTargetAgentIdsByAgents(autoRouterIds)
      : Promise.resolve(new Map<string, Set<string>>()),
    accessibleEnvironmentKeys.size > 0
      ? (async () => {
          const entries = await Promise.all(
            [...accessibleEnvironmentKeys.entries()].map(
              async ([envKey, environmentId]) => {
                const targets =
                  await AgentModel.findAccessibleDelegationTargets({
                    userId: params.actorUserId,
                    isAdmin: isAgentAdmin,
                    organizationId: params.organizationId,
                    includeDetails: false,
                    environmentId,
                  });
                for (const target of targets) {
                  nameByAgentId.set(target.id, target.name);
                }
                const sortedRuntimeIds = targets
                  .filter((target) => target.hasRuntime)
                  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
                  .map((target) => target.id);
                return [
                  envKey,
                  {
                    sortedIds: sortedRuntimeIds,
                    idSet: new Set(sortedRuntimeIds),
                  },
                ] as const;
              },
            ),
          );
          return new Map(entries);
        })()
      : Promise.resolve(
          new Map<string, { sortedIds: string[]; idSet: Set<string> }>(),
        ),
  ]);

  const candidateIdsByRouter = routerTargets.map((router) => {
    const cfg = routerConfigById.get(router.id);
    if (!cfg) {
      return { router, candidateIds: [] as string[] };
    }
    const envKey = cfg.environmentId ?? "__default__";
    if (cfg.accessAllSubagents) {
      const envRuntimeIds =
        accessibleTargetsByEnvKey.get(envKey)?.sortedIds ?? [];
      const routerExcluded = autoExcludedByRouter.get(router.id);
      const candidateIds = envRuntimeIds.filter(
        (id) =>
          id !== router.id &&
          !routerExcluded?.has(id) &&
          !callerExcludedSet.has(id),
      );
      return { router, candidateIds };
    }
    const assigned = assignedByManualRouter.get(router.id) ?? [];
    const accessibleSet = filterManualByActorAccess
      ? (accessibleTargetsByEnvKey.get(envKey)?.idSet ?? new Set<string>())
      : null;
    return {
      router,
      candidateIds: assigned.filter(
        (id) =>
          (!accessibleSet || accessibleSet.has(id)) &&
          !callerExcludedSet.has(id),
      ),
    };
  });

  const missingIds = [
    ...new Set(
      candidateIdsByRouter.flatMap(({ candidateIds }) =>
        candidateIds.filter((id) => !nameByAgentId.has(id)),
      ),
    ),
  ];
  if (missingIds.length > 0) {
    const basicRows = await AgentModel.findBasicByOrganizationIdAndIds({
      organizationId: params.organizationId,
      agentIds: missingIds,
    });
    for (const row of basicRows) {
      nameByAgentId.set(row.id, row.name);
    }
  }

  const poolNamesByRouterId = new Map<string, string[]>();
  const managingRoutersByWorkerId = new Map<string, RouterPoolReference[]>();

  for (const { router, candidateIds } of candidateIdsByRouter) {
    if (candidateIds.length === 0) continue;
    const poolNames = candidateIds
      .map((id) => nameByAgentId.get(id))
      .filter((name): name is string => Boolean(name));
    if (poolNames.length === 0) continue;
    poolNamesByRouterId.set(router.id, poolNames);
    const ref: RouterPoolReference = {
      routerName: router.name,
      routerToolName: router.toolName,
    };
    for (const workerId of candidateIds) {
      const existing = managingRoutersByWorkerId.get(workerId) ?? [];
      existing.push(ref);
      managingRoutersByWorkerId.set(workerId, existing);
    }
  }

  return { poolNamesByRouterId, managingRoutersByWorkerId };
}

function buildDelegationToolDescriptor(params: {
  name: string;
  targetAgent: {
    id: string;
    name: string;
    description?: string | null;
    builtInAgentConfig?: Agent["builtInAgentConfig"];
    hasRuntime?: boolean;
    hasSubagentLoadBalancing?: boolean;
  };
  inputSchema: Tool["inputSchema"];
  externalA2a?: boolean;
  toolId?: string;
  /** Guardrails v2 runs the target as a child that can attest its return. */
  attestable?: boolean;
  /** Names of pooled runtime subagents when `targetAgent` is a load-balanced router. */
  routerPoolNames?: readonly string[];
  /** Accessible load-balanced routers whose pool includes this runtime worker. */
  managingRouters?: readonly RouterPoolReference[];
}): Tool {
  const {
    name,
    targetAgent,
    inputSchema,
    externalA2a,
    toolId,
    routerPoolNames,
    managingRouters,
  } = params;
  const attestable =
    params.attestable === true &&
    !externalA2a &&
    !targetAgent.builtInAgentConfig;
  const isLoadBalancedRuntimeRouter =
    !externalA2a &&
    !targetAgent.hasRuntime &&
    Boolean(routerPoolNames && routerPoolNames.length > 0);
  const runsInRuntime =
    !externalA2a && (targetAgent.hasRuntime || isLoadBalancedRuntimeRouter);
  const managingRouterHint =
    !externalA2a &&
    targetAgent.hasRuntime &&
    managingRouters &&
    managingRouters.length > 0
      ? `Part of the load-balanced runtime pool of ${managingRouters.map((r) => `${r.routerName} (${r.routerToolName})`).join(", ")}. Prefer delegating to ${managingRouters[0].routerToolName} for automatic runtime selection and failover unless the user explicitly requested ${targetAgent.name}.`
      : null;
  const routerPoolNotice =
    isLoadBalancedRuntimeRouter && routerPoolNames
      ? `Automatic subagent load balancing and failover are enabled on this agent across its runtime pool (${routerPoolNames.join(", ")}), overriding any manual runtime selection: delegate directly to this agent without asking the user which runtime to use unless the user explicitly requested a specific runtime.`
      : null;
  const rawTargetDescription = targetAgent.description
    ? targetAgent.description.substring(0, 400)
    : null;
  const formattedTargetDescription =
    rawTargetDescription && (routerPoolNotice || managingRouterHint)
      ? /[.!?]\s*$/.test(rawTargetDescription)
        ? rawTargetDescription.trimEnd()
        : `${rawTargetDescription.trimEnd()}.`
      : rawTargetDescription;
  const description = [
    `Delegate task to ${externalA2a ? "external A2A " : ""}agent: ${targetAgent.name}.`,
    ...(runsInRuntime
      ? [
          "Runs in the background in Agent Runtime and returns a run link, not the answer.",
        ]
      : []),
    ...(formattedTargetDescription ? [formattedTargetDescription] : []),
    ...(routerPoolNotice ? [routerPoolNotice] : []),
    ...(managingRouterHint ? [managingRouterHint] : []),
  ].join(" ");

  return {
    name,
    title: targetAgent.name,
    description,
    inputSchema: advertiseRuntimeProof(
      attestable ? advertiseReturnSchema(inputSchema) : inputSchema,
    ),
    annotations: {},
    _meta: {
      targetAgentId: targetAgent.id,
      ...(externalA2a ? { targetType: "external_a2a" } : {}),
      ...(isLoadBalancedRuntimeRouter
        ? { [LOAD_BALANCED_RUNTIME_ROUTER_META_KEY]: true }
        : {}),
      ...(toolId ? { toolId } : {}),
    },
  };
}

function advertiseRuntimeProof(
  schema: Tool["inputSchema"],
): Tool["inputSchema"] {
  return {
    ...schema,
    properties: {
      ...schema.properties,
      runtime_proof: {
        type: "string",
        description: "Source-session proof supplied by the proxy.",
      },
    },
  };
}

const RETURN_SCHEMA_DESCRIPTION =
  "Optional. When you need structured facts back rather than prose, the JSON Schema the subagent's final answer must match. A match returns at your own trust, even when the subagent read untrusted data. Root: an object whose `properties` are all listed in `required`. Every leaf must be bounded: boolean; integer with `minimum` and `maximum`; number with `minimum`, `maximum` and `multipleOf` 10^-k; string with `enum`, `const` or `format`; array with `items` and `maxItems`. No free strings, optional fields, `additionalProperties` or combinators. Declare it before the subagent reads anything; omit it for a prose answer.";

function advertiseReturnSchema(
  schema: Tool["inputSchema"],
): Tool["inputSchema"] {
  return {
    ...schema,
    properties: {
      ...schema.properties,
      return_schema: { type: "object", description: RETURN_SCHEMA_DESCRIPTION },
    },
  };
}

/** The calling agent's own fork, offered first so a same-named agent never shadows it. */
async function finishDelegationTools(
  context: {
    agentId: string;
    organizationId: string;
    userId?: string;
    parentLlm?: ModelSelection;
    delegationChain?: string;
    oauthExecution?: A2AOAuthExecution;
  },
  tools: Tool[],
  attestable: boolean,
): Promise<Tool[]> {
  const caller = isForkRun(context)
    ? null
    : await AgentModel.findDelegationTarget(context.agentId);
  const tiers =
    caller?.agentType === "agent"
      ? await forkTiers({ ...context, caller })
      : [];
  const fork =
    caller?.agentType === "agent"
      ? [
          {
            ...buildDelegationToolDescriptor({
              name: SELF_FORK_TOOL_NAME,
              targetAgent: { id: caller.id, name: caller.name },
              inputSchema: selfForkInputSchema(tiers),
              attestable,
            }),
            title: "Fork yourself",
            description: selfForkDescription(tiers),
          },
        ]
      : [];
  const candidates = dedupeDelegationTools([...fork, ...tools]);
  if (!context.oauthExecution) return candidates;
  const execution = context.oauthExecution;
  const allowed = await Promise.all(
    candidates.map(async (tool) => {
      if (tool._meta?.targetType === "external_a2a") return tool;
      const targetAgentId = tool._meta?.targetAgentId;
      if (typeof targetAgentId !== "string") return null;
      try {
        await authorizeA2AOAuthExecution({
          agentId: targetAgentId,
          organizationId: context.organizationId,
          execution,
        });
        return tool;
      } catch {
        return null;
      }
    }),
  );
  return allowed.filter((tool) => tool !== null);
}

/**
 * The tiers the caller's fork can move to, from the same parent selection the
 * fork run resolves: the caller's own model and key, else the agent's config.
 */
async function forkTiers(params: {
  caller: {
    llmApiKeyId: string | null;
    modelId: string | null;
  };
  organizationId: string;
  userId?: string;
  parentLlm?: ModelSelection;
}): Promise<ForkTier[]> {
  const { caller, organizationId, userId, parentLlm } = params;
  if (!userId) return [];
  const parent = await resolveForkParentSelection({
    agent: caller,
    organizationId,
    userId,
    parentLlm,
  });
  return availableSubagentTiers({ parent, organizationId, userId });
}

/** A fork may not fork again, so it is not offered the fork tool. */
function isForkRun(context: {
  agentId: string;
  delegationChain?: string;
}): boolean {
  const chain = context.delegationChain?.split(":") ?? [];
  return chain.at(-1) === context.agentId && chain.at(-2) === context.agentId;
}

const SELF_FORK_TIER_USES = {
  smart:
    'With `tier: "smart"` the copy runs on a stronger model: hand it a hard reasoning step, or have it check your conclusion before you act on it.',
  fast: 'With `tier: "fast"` it runs on a cheaper, quicker model, for bulk reading, searching, or extraction.',
};

/** The fork's description, naming what each advertised tier is for. */
function selfForkDescription(tiers: ForkTier[]): string {
  return [
    "Run a self-contained task in a fresh copy of yourself: same tools and instructions, none of this conversation. Use it to keep long tool output, searches, or exploration out of your context when only the conclusion matters.",
    ...tiers.map((tier) => SELF_FORK_TIER_USES[tier]),
    "Put everything the copy needs in `message`, and say what to return. The copy cannot fork again.",
  ].join(" ");
}

function dedupeDelegationTools(tools: Tool[]): Tool[] {
  const names = new Set<string>();
  return tools.filter((tool) => {
    if (names.has(tool.name)) return false;
    names.add(tool.name);
    return true;
  });
}

/**
 * A delegated answer carries the start of the task it answers. A caller that
 * delegates several tasks at once otherwise has to pair answers with tasks by
 * tool call id alone, and models sometimes pair them by position instead. The
 * excerpt is bounded so the result's size budget stays with the answer.
 */
function delegationResult(task: string, answer: string) {
  const chars = Array.from(task);
  const excerpt =
    chars.length > TASK_ECHO_MAX_CHARS
      ? `${chars.slice(0, TASK_ECHO_MAX_CHARS).join("")}…`
      : task;
  return successResult(`Task:\n${excerpt}\n\nResult:\n${answer}`);
}

const TASK_ECHO_MAX_CHARS = 500;
