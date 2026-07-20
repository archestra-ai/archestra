import { SKILL_TOOL_PREFIX, slugify } from "@archestra/shared";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { DelegationLoopError } from "@/agents/errors";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import { AgentModel, SkillModel, SkillTeamModel } from "@/models";
import { ProviderError } from "@/routes/chat/errors";
import {
  buildSkillActivationPromptContext,
  formatSkillActivation,
} from "@/skills/skill-activation";
import { resolveActivationVersion } from "@/skills/skill-version-resolution";
import type { Skill } from "@/types";
import { delegationToolArgsSchema } from "./delegation";
import { errorResult, isAbortLikeError, successResult } from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * Skill delegation: running an agent-designated skill in its subagent.
 *
 * A skill whose SKILL.md declares an `agent` runs *in that agent* instead of
 * loading its instructions into the caller's context. Each such skill the
 * caller can access becomes a `skill__<slug>` tool; calling it renders the
 * skill's activation block, prepends it to the caller's task, and dispatches
 * the whole thing to the designated agent via A2A — the parent only ever sees
 * the subagent's answer, mirroring how `agent__*` delegation tools work.
 *
 * Access rules (surface and dispatch are symmetric, so a caller can only run
 * what it saw):
 * - real signed-in user only — system/token flows get no skill delegation
 *   tools, the same fail-closed gate as Auto-mode agent delegation
 * - the skill must be accessible to the user (scope) and visible from the
 *   calling agent's environment
 * - the designated agent must resolve in the same environment and be
 *   accessible to the user, under the same rules as agent delegation targets
 */

// === Exports ===

/**
 * Build the `skill__<slug>` tool surface for an agent: one tool per
 * caller-accessible, same-environment skill that designates an execution
 * agent whose target also resolves. Skills are name-ordered and deduped by
 * slug (first wins), matching dispatch's `.find()` semantics.
 */
export async function getSkillDelegationTools(context: {
  agentId: string;
  organizationId: string;
  userId?: string;
}): Promise<Tool[]> {
  const { agentId, organizationId, userId } = context;

  if (!isRealUser(userId)) {
    return [];
  }

  const [skills, targetsBySlug] = await Promise.all([
    findAgentDesignatedSkills({ agentId, organizationId, userId }),
    findDelegationTargetsBySlug({ agentId, organizationId, userId }),
  ]);

  const seenNames = new Set<string>();
  const tools: Tool[] = [];
  for (const skill of skills) {
    const target = targetsBySlug.get(slugify(skill.agentName ?? ""));
    // a skill whose designated agent does not resolve (wrong environment, no
    // access, deleted) is not advertised — its dispatch would only fail.
    if (!target) {
      continue;
    }
    const name = `${SKILL_TOOL_PREFIX}${slugify(skill.name)}`;
    if (seenNames.has(name)) {
      continue;
    }
    seenNames.add(name);
    tools.push({
      name,
      title: skill.name,
      description:
        `Run the Agent Skill "${skill.name}" in the "${target.name}" ` +
        `subagent: ${skill.description.substring(0, 400)} Pass the task as ` +
        "`message`; the subagent receives the skill's instructions " +
        "automatically and returns the result.",
      inputSchema: SKILL_DELEGATION_INPUT_JSON_SCHEMA,
      annotations: {},
      _meta: { skillId: skill.id, targetAgentId: target.id },
    });
  }

  logger.debug(
    {
      agentId,
      organizationId,
      userId,
      designatedSkillCount: skills.length,
      exposedToolCount: tools.length,
    },
    "Built skill delegation tools",
  );

  return tools;
}

export async function handleSkillDelegation(
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

  // The caller user can be present even when the selected gateway token is
  // team/org scoped. Same fail-closed real-user gate as the surface.
  const userId = context.userId ?? tokenAuth?.userId;
  if (!isRealUser(userId)) {
    return errorResult(
      "Skill delegation requires a signed-in user; it is unavailable in automated runs.",
    );
  }

  const skillSlug = toolName.replace(SKILL_TOOL_PREFIX, "");

  // Resolve the skill and its designated agent with the same rules that built
  // the advertised surface, so a caller can only dispatch what it saw.
  const skills = await findAgentDesignatedSkills({
    agentId,
    organizationId,
    userId,
  });
  const skill = skills.find((s) => slugify(s.name) === skillSlug);
  if (!skill) {
    return errorResult(
      `No skill delegation is configured for "${SKILL_TOOL_PREFIX}${skillSlug}". Use an exact skill delegation tool name (${SKILL_TOOL_PREFIX}*) from your tools list. Do not guess skill names.`,
    );
  }

  const targetsBySlug = await findDelegationTargetsBySlug({
    agentId,
    organizationId,
    userId,
  });
  const target = targetsBySlug.get(slugify(skill.agentName ?? ""));
  if (!target) {
    return errorResult(
      `Skill "${skill.name}" designates the agent "${skill.agentName}", which is not available — it may not exist in this environment, or you may lack access to it.`,
    );
  }

  // Pin the skill's effective version and render its activation block exactly
  // as load_skill would, minus the sandbox mount: the block travels to the
  // subagent, whose own sandbox has nothing mounted.
  const activation = await resolveActivationVersion({
    skill,
    organizationId,
    userId,
    conversationId: context.conversationId,
    isolationKey: context.isolationKey,
    canRunSandbox: false,
  });
  if (!activation) {
    return errorResult(`Skill "${skill.name}" has no readable version.`);
  }

  const activationBlock = formatSkillActivation({
    skill: {
      name: skill.name,
      content: activation.version.content,
      compatibility: skill.compatibility,
      allowedTools: skill.allowedTools,
      templated: skill.templated,
    },
    version: activation.version.version,
    files: [],
    canRunSandbox: false,
    promptContext: skill.templated
      ? await buildSkillActivationPromptContext({ userId, organizationId })
      : null,
  });

  const delegatedMessage =
    `${activationBlock}\n\n` +
    "Follow the skill instructions above to complete this task:\n\n" +
    message;

  // The caller's ancestor path, which the executor checks for cycles.
  const parentDelegationChain = context.delegationChain || context.agentId;

  try {
    const sessionId =
      context.sessionId || context.conversationId || context.isolationKey;

    logger.info(
      {
        agentId,
        skillId: skill.id,
        skillName: skill.name,
        targetAgentId: target.id,
        targetAgentName: target.name,
        organizationId,
        userId,
        sessionId,
      },
      "Executing skill delegation tool",
    );

    const result = await executeA2AMessage({
      agentId: target.id,
      message: delegatedMessage,
      organizationId,
      userId,
      sessionId,
      parentDelegationChain,
      conversationId: context.conversationId,
      isolationKey: context.isolationKey,
      chatOpsBindingId: context.chatOpsBindingId,
      chatOpsThreadId: context.chatOpsThreadId,
      scheduleTriggerRunId: context.scheduleTriggerRunId,
      abortSignal: context.abortSignal,
      parentContextIsTrusted: context.contextIsTrusted,
      subagentToolStream: context.subagentToolStream,
      delegationToolCallId: context.currentToolCallId,
    });

    return successResult(result.text);
  } catch (error) {
    if (isAbortLikeError(error)) {
      logger.info(
        { agentId, skillId: skill.id, targetAgentId: target.id },
        "Skill delegation was aborted",
      );
      throw error;
    }
    if (error instanceof DelegationLoopError) {
      logger.info(
        {
          agentId,
          skillId: skill.id,
          targetAgentId: target.id,
          parentDelegationChain,
        },
        "Skill delegation refused to avoid a delegation loop",
      );
      return errorResult(error.message);
    }
    logger.error(
      { error, agentId, skillId: skill.id, targetAgentId: target.id },
      "Skill delegation tool execution failed",
    );
    // Re-throw ProviderError so it propagates to the parent stream's onError
    // with the correct provider info (the subagent can't produce output).
    if (error instanceof ProviderError) {
      throw error;
    }
    return errorResult(
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

// === Internal ===

// Same {message} input as agent delegation tools, so the two delegation
// surfaces are indistinguishable to the model.
const SKILL_DELEGATION_INPUT_JSON_SCHEMA = z.toJSONSchema(
  delegationToolArgsSchema,
  { io: "input" },
) as Tool["inputSchema"];

function isRealUser(userId: string | undefined): userId is string {
  return Boolean(userId) && userId !== "system";
}

/**
 * Caller-accessible skills, restricted to the calling agent's environment,
 * that designate an execution agent — name-ordered so slug dedup and dispatch
 * resolution agree.
 */
async function findAgentDesignatedSkills(params: {
  agentId: string;
  organizationId: string;
  userId: string;
}): Promise<Skill[]> {
  const { agentId, organizationId, userId } = params;

  const [environmentId, checker] = await Promise.all([
    AgentModel.findEnvironmentId(agentId),
    getSkillPermissionChecker({ userId, organizationId }),
  ]);
  const accessibleSkillIds = checker.isAdmin
    ? undefined
    : await SkillTeamModel.getUserAccessibleSkillIds({
        organizationId,
        userId,
      });

  const skills = await SkillModel.findByOrganization({
    organizationId,
    accessibleSkillIds,
    environmentId,
  });
  return skills
    .filter((skill) => skill.agentName !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The user's reachable delegation targets from this agent (same-environment,
 * access-checked, self excluded — the exact agent-delegation rules), keyed by
 * name slug for designated-agent matching. First wins on slug collisions
 * (targets are name-ordered).
 */
async function findDelegationTargetsBySlug(params: {
  agentId: string;
  organizationId: string;
  userId: string;
}): Promise<Map<string, { id: string; name: string }>> {
  const { agentId, organizationId, userId } = params;

  const [environmentId, isAgentAdmin] = await Promise.all([
    AgentModel.findEnvironmentId(agentId),
    userHasPermission(userId, organizationId, "agent", "admin"),
  ]);

  const targets = await AgentModel.findAccessibleDelegationTargets({
    userId,
    isAdmin: isAgentAdmin,
    excludeAgentId: agentId,
    environmentId,
  });

  const bySlug = new Map<string, { id: string; name: string }>();
  for (const target of targets) {
    const slug = slugify(target.name);
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { id: target.id, name: target.name });
    }
  }
  return bySlug;
}
