import {
  AGENT_TOOL_PREFIX,
  SELF_FORK_TOOL_NAME,
  slugify,
} from "@archestra/shared";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { convertToModelMessages, type ModelMessage } from "ai";
import { z } from "zod";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { DelegationLoopError } from "@/agents/errors";
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
  startRuntimeChild,
  withCapturedGuardrailsActivation,
} from "@/openappa/service";
import {
  mintSubagentBinding,
  type SubagentBinding,
  subagentReturnPrefix,
} from "@/openappa/subagent-binding";
import { ProviderError, SubagentProviderError } from "@/routes/chat/errors";
import { executeOutboundA2aDelegation } from "@/services/a2a-outbound-client";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import {
  promptWithContract,
  SPAWN_TARGET_MISMATCH,
} from "@/services/agent-runtime/runtime-crossing";
import { isGuardrailsV2Active } from "@/services/guardrails-deployment";
import { ResourcePermissions } from "@/services/resource-permissions";
import { type Agent, ApiError } from "@/types";
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
}): Promise<Tool[]> {
  const { agentId, organizationId, userId, skipAccessCheck, lookups } = context;

  // Delegation never crosses environment boundaries (null is the Default
  // environment), mirroring tool isolation: in both modes only same-environment
  // targets are advertised.
  const environmentId = lookups
    ? await lookups.agentEnvironmentId(agentId)
    : await AgentModel.findEnvironmentId(agentId);

  // External A2A targets are always explicit, including when local subagents
  // use Auto mode. Assigning an external credential is an egress decision and
  // must never be widened by a dynamic local-agent setting.
  // External A2A currently executes from the backend process, outside the
  // per-environment network-policy runtime. Fail closed for environment-bound
  // agents until connections can be bound to and dialed through that runtime.
  const realUserId = userId && userId !== "system" ? userId : undefined;
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
    (lookups
      ? await lookups.agentAccessAllSubagents(agentId)
      : await AgentModel.getAccessAllSubagents(agentId))
  ) {
    const localTools = await buildAutoDelegationTools({
      agentId,
      organizationId,
      userId: realUserId,
      environmentId,
      attestable,
    });
    return finishDelegationTools(
      agentId,
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

  // Convert DB tools to MCP Tool format
  const localTools = accessibleTools.map((t) =>
    buildDelegationToolDescriptor({
      name: t.tool.name,
      targetAgent: t.targetAgent,
      inputSchema: t.tool.parameters as Tool["inputSchema"],
      attestable,
    }),
  );
  return finishDelegationTools(
    agentId,
    [...outboundTools, ...localTools],
    attestable,
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
      return successResult(text);
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

  // Agent Runtime is a capability of the target Agent, not a separate
  // invocation syntax. The ordinary agent__* delegation tool therefore turns
  // into a detached durable task whenever that target has a runtime. A
  // direct conversation with the same Agent never enters this path and stays
  // in the foreground loop.
  // A fork is a copy of the running caller, so it always runs in this process.
  const targetAgent = await AgentModel.findById(target.id);
  if (!selfFork && targetAgent && resolveAgentRuntime(targetAgent)) {
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
      selfFork,
      ...(spawn.binding ? { appaSubagent: spawn.binding.child } : {}),
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
      // Surface the child's tool calls on the caller's conversation, attributed
      // to this delegation call. The shared bridge is threaded into the child
      // run so deeper descendants surface too.
      subagentToolStream: context.subagentToolStream,
      delegationToolCallId: context.currentToolCallId,
    };
    const task =
      promptWithContract(message, spawn.binding?.contract) ?? message;
    if (!spawn.binding) {
      return successResult(
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
}): Promise<Tool[]> {
  const { agentId, organizationId, userId, environmentId, attestable } = params;

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
  const tools: Tool[] = [];

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
    tools.push(
      buildDelegationToolDescriptor({
        name,
        targetAgent,
        inputSchema: DELEGATION_INPUT_JSON_SCHEMA,
        attestable,
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
  const match = sortDelegationTargets(targets).find(
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

function buildDelegationToolDescriptor(params: {
  name: string;
  targetAgent: {
    id: string;
    name: string;
    description?: string | null;
    builtInAgentConfig?: Agent["builtInAgentConfig"];
  };
  inputSchema: Tool["inputSchema"];
  externalA2a?: boolean;
  toolId?: string;
  /** Guardrails v2 runs the target as a child that can attest its return. */
  attestable?: boolean;
}): Tool {
  const { name, targetAgent, inputSchema, externalA2a, toolId } = params;
  const attestable =
    params.attestable === true &&
    !externalA2a &&
    !targetAgent.builtInAgentConfig;
  const description = targetAgent.description
    ? `Delegate task to ${externalA2a ? "external A2A " : ""}agent: ${targetAgent.name}. ${targetAgent.description.substring(0, 400)}`
    : `Delegate task to ${externalA2a ? "external A2A " : ""}agent: ${targetAgent.name}`;

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
  agentId: string,
  tools: Tool[],
  attestable: boolean,
): Promise<Tool[]> {
  const caller = await AgentModel.findDelegationTarget(agentId);
  const fork =
    caller?.agentType === "agent"
      ? [
          {
            ...buildDelegationToolDescriptor({
              name: SELF_FORK_TOOL_NAME,
              targetAgent: { id: caller.id, name: caller.name },
              inputSchema: DELEGATION_INPUT_JSON_SCHEMA,
              attestable,
            }),
            title: "Fork yourself",
            description: SELF_FORK_DESCRIPTION,
          },
        ]
      : [];
  return dedupeDelegationTools([...fork, ...tools]);
}

const SELF_FORK_DESCRIPTION =
  "Run a self-contained task in a fresh copy of yourself: same tools and instructions, none of this conversation. Use it to keep long tool output, searches, or exploration out of your context when only the conclusion matters. Put everything the copy needs in `message`, and say what to return. The copy cannot fork again.";

function dedupeDelegationTools(tools: Tool[]): Tool[] {
  const names = new Set<string>();
  return tools.filter((tool) => {
    if (names.has(tool.name)) return false;
    names.add(tool.name);
    return true;
  });
}
