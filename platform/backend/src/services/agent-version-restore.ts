import {
  getResourceForAgentType,
  IncomingEmailSecurityModeSchema,
} from "@archestra/shared";
import { userHasPermission } from "@/auth";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import { knowledgeSourceAccessControlService } from "@/knowledge-base";
import logger from "@/logging";
import {
  AgentExcludedSubagentModel,
  AgentExcludedToolModel,
  AgentModel,
  AgentToolModel,
  AgentVersionModel,
  HookFileModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  LlmProviderApiKeyModel,
  ModelModel,
  ToolModel,
} from "@/models";
import { agentSubagentExclusionsService } from "@/services/agent-subagent-exclusions";
import {
  assignToolToAgent,
  validateAssignment,
} from "@/services/agent-tool-assignment";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { assertCanAssignEnvironment } from "@/services/environments/environment";
import type { Agent, CredentialResolutionMode, UpdateAgent } from "@/types";
import {
  ApiError,
  CredentialResolutionModeSchema,
  ToolExposureModeSchema,
} from "@/types";
import type { AgentConfigSnapshot } from "@/types/agent-version";
import type { InsertHookFile } from "@/types/hook";
import { InsertHookFileSchema } from "@/types/hook";

/**
 * Restore an agent's config to an earlier version by replaying its immutable
 * snapshot forward: the restored config becomes a NEW head version, so nothing
 * in the history is rewritten (git-revert semantics).
 *
 * All-or-nothing at the validation boundary. The governing rule is that a
 * restore succeeds exactly when the caller could have reached the same end
 * state through the ordinary write handlers — so the plan is built by diffing
 * live config against the snapshot and validating only what would actually be
 * written. A reference that is unchanged needs no handler call to reach its
 * target state, and is therefore neither written nor validated; anything that
 * WOULD be written is validated with the same rules its handler applies, and a
 * rejection fails the whole restore before a single row is touched. A version
 * pointing at something deleted or out of the caller's reach is simply not
 * restorable.
 *
 * Ordering:
 * 1. Read the snapshot, so a pruned or foreign version 404s immediately.
 * 2. Build the plan — every read and every validation, no writes. This is
 *    where a restore fails.
 * 3. Fork, which does double duty. Version coverage is best-effort at
 *    operation boundaries, so live config can be ahead of the head snapshot;
 *    forking here records the true pre-restore state as a recoverable version.
 *    Passing `baseVersion` also makes it the compare-and-set. It sits below
 *    the plan so a rejected restore mints nothing.
 * 4. Apply, then fork once more so one restore yields one new version. This
 *    fork runs even when the apply throws, so a FAILED restore can mint a
 *    version too — see below.
 *
 * The apply spans several write paths that each own their transaction, so it
 * is not atomic. Nothing in it validates, and the preflight's reads are not
 * locked, so the residual failure window is a referent deleted between plan
 * and apply — small, and a partial apply leaves live config closer to the
 * snapshot than it was.
 *
 * That partial state is recorded rather than left dangling: step 4's fork is in
 * a `finally`, so the writes that landed before the throw become a version like
 * any other config change. Two consequences for callers. The version is a real,
 * restorable point in the history even though nobody authored it, and it counts
 * against the retention window. And the head has moved despite the 400, so a
 * client holding the `baseVersion` it sent must re-read the agent before
 * retrying — retrying on the stale anchor 409s (`agent_version_conflict`).
 */
export async function restoreAgentVersion(params: {
  agentId: string;
  version: number;
  baseVersion?: number;
  userId: string;
  organizationId: string;
}): Promise<Agent> {
  const { agentId, version, userId, organizationId } = params;

  const versionRow = await AgentVersionModel.findByAgentAndVersion({
    agentId,
    version,
    organizationId,
  });
  if (!versionRow) {
    throw new ApiError(404, `Agent has no version ${version}`);
  }

  const plan = await buildRestorePlan({
    agentId,
    organizationId,
    userId,
    snapshot: versionRow.snapshot,
  });

  // Throws 409 (`agent_version_conflict`) when the head moved past baseVersion.
  const fork = await AgentVersionModel.forkIfChanged(agentId, {
    expectedLatestVersion: params.baseVersion,
  });
  if (!fork) {
    throw new ApiError(404, "Agent not found");
  }

  try {
    await applyRestorePlan(plan);
  } finally {
    // One fork for the whole apply, minted on the failure path too: whatever
    // landed before a throw is already live, so history has to account for it
    // rather than leave the state uncaptured until an unrelated later write.
    //
    // Best-effort like every post-commit fork: the config is already live, so a
    // fork failure must not fail the restore. That is also what makes `finally`
    // safe here — `forkIfChangedBestEffort` swallows its own errors, so it can
    // never replace the in-flight rejection with a fork error. A refactor that
    // lets it throw would silently turn a 400 into a 500.
    await AgentVersionModel.forkIfChangedBestEffort(agentId);
  }

  // Re-read rather than returning the update's result: that update deferred its
  // fork, so its `latestVersion` is the pre-restore head, and clients anchor
  // their next restore on the value this response carries.
  const agent = await AgentModel.findById(agentId, userId, true);
  if (!agent) {
    throw new ApiError(404, "Agent not found");
  }

  logger.info(
    { agentId, restoredFromVersion: version },
    "Restored agent config version",
  );

  return agent;
}

// === Internal helpers ===

type SnapshotToolRef = AgentConfigSnapshot["tools"][number];

/** A snapshot tool ref whose credential mode has already been validated. */
type PlannedAssignment = {
  toolId: string;
  name: string;
  mcpServerId: string | null;
  credentialResolutionMode: CredentialResolutionMode;
};

/**
 * Everything the apply needs, fully resolved and validated. `null` on a
 * collection means "live already matches the snapshot" — that surface is
 * neither written nor validated, which is what makes restoring an unchanged
 * agent a true no-op and what keeps a stale reference the restore does not
 * touch from failing it.
 */
type RestorePlan = {
  agentId: string;
  organizationId: string;
  scalars: Partial<UpdateAgent>;
  toolsToAssign: PlannedAssignment[];
  toolIdsToUnassign: string[];
  hooks: InsertHookFile[] | null;
  excludedToolIds: string[] | null;
  excludedSubagentIds: string[] | null;
  knowledge: { knowledgeBaseIds: string[]; connectorIds: string[] } | null;
};

async function buildRestorePlan(params: {
  agentId: string;
  organizationId: string;
  userId: string;
  snapshot: AgentConfigSnapshot;
}): Promise<RestorePlan> {
  const { agentId, organizationId, userId, snapshot } = params;

  const current = await AgentModel.findById(agentId, userId, true);
  if (!current) {
    throw new ApiError(404, "Agent not found");
  }

  const [
    assignments,
    currentHooks,
    currentExcludedToolIds,
    currentExcludedSubagentIds,
  ] = await Promise.all([
    AgentToolModel.findAssignmentsByAgent(agentId),
    HookFileModel.listByAgent(agentId, organizationId),
    AgentExcludedToolModel.findToolIdsByAgent(agentId),
    AgentExcludedSubagentModel.findTargetAgentIdsByAgent(agentId),
  ]);

  const { toolsToAssign, toolIdsToUnassign } = diffTools(snapshot, assignments);

  return {
    agentId,
    organizationId,
    scalars: await planScalars({ snapshot, current, userId, organizationId }),
    toolsToAssign: await planToolAssignments({ agentId, refs: toolsToAssign }),
    toolIdsToUnassign,
    hooks: planHooks({ agentId, organizationId, snapshot, currentHooks }),
    excludedToolIds: await planExcludedTools({
      organizationId,
      snapshot,
      currentExcludedToolIds,
    }),
    excludedSubagentIds: sameIds(
      snapshot.excludedSubagents.map((ref) => ref.agentId),
      currentExcludedSubagentIds,
    )
      ? null
      : snapshot.excludedSubagents.map((ref) => ref.agentId),
    knowledge: await planKnowledge({
      snapshot,
      current,
      userId,
      organizationId,
    }),
  };
}

async function applyRestorePlan(plan: RestorePlan): Promise<void> {
  for (const ref of plan.toolsToAssign) {
    const result = await assignToolToAgent({
      agentId: plan.agentId,
      toolId: ref.toolId,
      mcpServerId: ref.mcpServerId,
      credentialResolutionMode: ref.credentialResolutionMode,
      deferVersionFork: true,
    });
    // The plan validated this exact assignment; a rejection here means the
    // referent changed in between. Fail rather than silently drop the tool.
    if (result && result !== "duplicate" && result !== "updated") {
      throw unrestorable(`tool "${ref.name}" (${result.error.message})`);
    }
  }

  for (const toolId of plan.toolIdsToUnassign) {
    await AgentToolModel.delete({
      agentId: plan.agentId,
      toolId,
      deferVersionFork: true,
    });
  }

  if (plan.hooks !== null) {
    await HookFileModel.replaceForAgent({
      agentId: plan.agentId,
      organizationId: plan.organizationId,
      hooks: plan.hooks,
      deferVersionFork: true,
    });
  }

  if (Object.keys(plan.scalars).length > 0 || plan.knowledge !== null) {
    const updated = await AgentModel.update(
      plan.agentId,
      { ...plan.scalars, ...(plan.knowledge ?? {}) },
      {
        deferVersionFork: true,
        // The snapshot's exclusion set is authoritative. Without this, an
        // accessAllTools off→on flip runs the additive built-in pre-fill and
        // silently re-excludes every built-in the version had available —
        // invisible to the plan, which diffed exclusions before this ran.
        skipExclusionPrefill: true,
      },
    );
    if (!updated) {
      throw new ApiError(404, "Agent not found");
    }
  }

  if (plan.excludedToolIds !== null) {
    await agentToolExclusionsService.replaceExclusions({
      agentId: plan.agentId,
      organizationId: plan.organizationId,
      excludedToolIds: plan.excludedToolIds,
      deferVersionFork: true,
    });
  }

  if (plan.excludedSubagentIds !== null) {
    await agentSubagentExclusionsService.replaceExclusions({
      agentId: plan.agentId,
      organizationId: plan.organizationId,
      excludedSubagentIds: plan.excludedSubagentIds,
      deferVersionFork: true,
    });
  }

  // Assign/unassign evict nothing on their own — the tool routes do it, and
  // this service bypasses them. Without this a live chat keeps serving the
  // pre-restore tool list.
  clearChatMcpClient(plan.agentId);
}

/**
 * Scalar fields that differ from live, and only those: an unchanged field
 * needs no handler call, so it is neither written nor validated. That is what
 * lets a version survive an enum rename it never touched, and what makes
 * restoring the current config skip the agents-row write entirely.
 */
async function planScalars(params: {
  snapshot: AgentConfigSnapshot;
  current: Agent;
  userId: string;
  organizationId: string;
}): Promise<Partial<UpdateAgent>> {
  const { snapshot, current, userId, organizationId } = params;
  const scalars: Partial<UpdateAgent> = {};

  const plain = {
    name: snapshot.name,
    description: snapshot.description,
    icon: snapshot.icon,
    systemPrompt: snapshot.systemPrompt,
    considerContextUntrusted: snapshot.considerContextUntrusted,
    accessAllTools: snapshot.accessAllTools,
    accessAllSubagents: snapshot.accessAllSubagents,
    incomingEmailEnabled: snapshot.incomingEmailEnabled,
    incomingEmailAllowedDomain: snapshot.incomingEmailAllowedDomain,
  };
  for (const [key, value] of Object.entries(plain)) {
    if (value !== (current[key as keyof Agent] ?? null)) {
      (scalars as Record<string, unknown>)[key] = value;
    }
  }

  // Header NAMES only, and order is not meaningful — the snapshot stores them
  // sorted, so compare sorted.
  if (!sameIds(snapshot.passthroughHeaders, current.passthroughHeaders ?? [])) {
    scalars.passthroughHeaders = snapshot.passthroughHeaders;
  }

  // Prompt order is author-meaningful, so this compares as a sequence.
  if (
    JSON.stringify(snapshot.suggestedPrompts) !==
    JSON.stringify(
      current.suggestedPrompts.map((p) => ({
        summaryTitle: p.summaryTitle,
        prompt: p.prompt,
      })),
    )
  ) {
    scalars.suggestedPrompts = snapshot.suggestedPrompts;
  }

  // Enum-ish fields are plain strings in the snapshot so history outlives enum
  // changes. Parsed only when the value actually has to be written: if live
  // already holds it, a value the current schema no longer knows is left alone
  // rather than blocking the restore.
  if (snapshot.toolExposureMode !== current.toolExposureMode) {
    const parsed = ToolExposureModeSchema.safeParse(snapshot.toolExposureMode);
    if (!parsed.success) {
      throw unrestorable(
        `tool exposure mode "${snapshot.toolExposureMode}" is no longer a valid value`,
      );
    }
    scalars.toolExposureMode = parsed.data;
  }
  if (
    snapshot.incomingEmailSecurityMode !== current.incomingEmailSecurityMode
  ) {
    const parsed = IncomingEmailSecurityModeSchema.safeParse(
      snapshot.incomingEmailSecurityMode,
    );
    if (!parsed.success) {
      throw unrestorable(
        `incoming email security mode "${snapshot.incomingEmailSecurityMode}" is no longer a valid value`,
      );
    }
    scalars.incomingEmailSecurityMode = parsed.data;
  }

  // Gated by the caller's CURRENT deploy-to-restricted permission, exactly like
  // setting it through the update route. `null` is gated too: it does not mean
  // "no environment" but the implicit default one, which an org can mark
  // restricted — so leaving it ungated would make a restore a way to move an
  // agent into a restricted default the update route refuses.
  if (snapshot.environmentId !== (current.environmentId ?? null)) {
    const canDeployToRestricted = await userHasPermission(
      userId,
      organizationId,
      getResourceForAgentType(current.agentType),
      "deploy-to-restricted",
    );
    await assertCanAssignEnvironment({
      environmentId: snapshot.environmentId,
      organizationId,
      canDeployToRestricted,
    });
    scalars.environmentId = snapshot.environmentId;
  }

  // A model and its API key are a pair: written whole or not at all, the
  // invariant the update route enforces. The existence check is stricter than
  // that route, which validates neither — but writing a dangling FK would 500
  // where this reports a version that cannot be restored.
  const snapshotModelId = snapshot.model?.id ?? null;
  const snapshotKeyId = snapshot.llmApiKey?.id ?? null;
  if (
    snapshotModelId !== (current.modelId ?? null) ||
    snapshotKeyId !== (current.llmApiKeyId ?? null)
  ) {
    if ((snapshotModelId === null) !== (snapshotKeyId === null)) {
      throw unrestorable("its model and API key were not captured as a pair");
    }
    if (snapshotModelId !== null && snapshotKeyId !== null) {
      const [model, apiKey] = await Promise.all([
        ModelModel.findById(snapshotModelId),
        LlmProviderApiKeyModel.findById(snapshotKeyId),
      ]);
      if (!model) {
        throw unrestorable(
          `model "${snapshot.model?.externalId}" no longer exists`,
        );
      }
      if (!apiKey || apiKey.organizationId !== organizationId) {
        throw unrestorable(
          `API key "${snapshot.llmApiKey?.name}" no longer exists`,
        );
      }
    }
    scalars.modelId = snapshotModelId;
    scalars.llmApiKeyId = snapshotKeyId;
  }

  // identityProviderId is captured but deliberately not replayed: migration
  // 0215 cleared it for agent_type='agent' and no write path sets it anymore
  // (clone and import both null it), so there is no value to restore.

  return scalars;
}

/**
 * Assignments to write and rows to drop. Tool identity is the whole
 * `(toolId, mcpServerId, credentialResolutionMode)` tuple, not just the id:
 * the same tool under a different server or credential mode is a different
 * configuration, and comparing ids alone would report "unchanged" and silently
 * leave that part of the version unrestored.
 */
function diffTools(
  snapshot: AgentConfigSnapshot,
  assignments: Awaited<
    ReturnType<typeof AgentToolModel.findAssignmentsByAgent>
  >,
): { toolsToAssign: SnapshotToolRef[]; toolIdsToUnassign: string[] } {
  const live = new Map(assignments.map((row) => [row.toolId, row]));
  const snapshotToolIds = new Set(snapshot.tools.map((ref) => ref.toolId));

  return {
    toolsToAssign: snapshot.tools.filter((ref) => {
      const row = live.get(ref.toolId);
      return (
        !row ||
        row.mcpServerId !== ref.mcpServerId ||
        row.credentialResolutionMode !== ref.credentialResolutionMode
      );
    }),
    toolIdsToUnassign: assignments
      .map((row) => row.toolId)
      .filter((toolId) => !snapshotToolIds.has(toolId)),
  };
}

/**
 * Run each pending assignment through the same validator the single-tool
 * assign route uses. Not caller-scoped: it resolves the MCP-server ownership
 * context from the *agent*, never from the user running the restore, so a
 * restore grants exactly what a direct assign would — the route gates the
 * whole operation on the matching agent-type and scope checks.
 */
async function planToolAssignments(params: {
  agentId: string;
  refs: SnapshotToolRef[];
}): Promise<PlannedAssignment[]> {
  const { agentId, refs } = params;
  if (refs.length === 0) {
    return [];
  }

  // One batched read for the whole set; a soft-deleted tool is absent from the
  // map, which `validateAssignment` reads as not-found — the same answer its
  // own per-tool lookup would give.
  const tools = await ToolModel.getByIds(refs.map((ref) => ref.toolId));
  const preFetchedData = {
    existingAgentIds: new Set([agentId]),
    toolsMap: new Map(tools.map((tool) => [tool.id, tool])),
  };

  const planned: PlannedAssignment[] = [];
  for (const ref of refs) {
    const mode = CredentialResolutionModeSchema.safeParse(
      ref.credentialResolutionMode,
    );
    if (!mode.success) {
      throw unrestorable(
        `credential mode "${ref.credentialResolutionMode}" for tool "${ref.name}" is no longer a valid value`,
      );
    }
    const error = await validateAssignment({
      agentId,
      toolId: ref.toolId,
      mcpServerId: ref.mcpServerId,
      credentialResolutionMode: mode.data,
      preFetchedData,
    });
    if (error) {
      throw unrestorable(`tool "${ref.name}" (${error.error.message})`);
    }
    planned.push({
      toolId: ref.toolId,
      name: ref.name,
      mcpServerId: ref.mcpServerId,
      credentialResolutionMode: mode.data,
    });
  }
  return planned;
}

/**
 * Hooks are compared on content, not row identity — ids and timestamps differ
 * on every row and would make every restore look like a change.
 */
function planHooks(params: {
  agentId: string;
  organizationId: string;
  snapshot: AgentConfigSnapshot;
  currentHooks: Awaited<ReturnType<typeof HookFileModel.listByAgent>>;
}): InsertHookFile[] | null {
  const { agentId, organizationId, snapshot, currentHooks } = params;

  const identity = (hook: {
    event: string;
    fileName: string;
    content: string;
    requirements: string[] | null;
    enabled: boolean;
  }) =>
    JSON.stringify([
      hook.event,
      hook.fileName,
      hook.content,
      hook.requirements ?? [],
      hook.enabled,
    ]);

  if (sameIds(snapshot.hooks.map(identity), currentHooks.map(identity))) {
    return null;
  }

  return snapshot.hooks.map((hook) => {
    const parsed = InsertHookFileSchema.safeParse({
      agentId,
      organizationId,
      event: hook.event,
      fileName: hook.fileName,
      content: hook.content,
      requirements: hook.requirements,
      enabled: hook.enabled,
    });
    if (!parsed.success) {
      throw unrestorable(`hook "${hook.fileName}" is no longer valid`);
    }
    return parsed.data;
  });
}

async function planExcludedTools(params: {
  organizationId: string;
  snapshot: AgentConfigSnapshot;
  currentExcludedToolIds: string[];
}): Promise<string[] | null> {
  const { organizationId, snapshot, currentExcludedToolIds } = params;
  const desired = snapshot.excludedTools.map((ref) => ref.toolId);
  if (sameIds(desired, currentExcludedToolIds)) {
    return null;
  }
  // Same validation the exclusions route applies, run before anything is
  // written rather than inside the replace transaction.
  await agentToolExclusionsService.validateToolIds(desired, organizationId);
  return desired;
}

/**
 * Knowledge access is enforced against the restoring caller, mirroring the
 * update route — which rejects a source that is missing OR out of reach with
 * the same 404, so this does not distinguish them either. Both are whole-array
 * surfaces: the handler only accepts the complete set, so any change means
 * every member has to validate.
 */
async function planKnowledge(params: {
  snapshot: AgentConfigSnapshot;
  current: Agent;
  userId: string;
  organizationId: string;
}): Promise<{ knowledgeBaseIds: string[]; connectorIds: string[] } | null> {
  const { snapshot, current, userId, organizationId } = params;
  const knowledgeBaseIds = snapshot.knowledgeBases.map((ref) => ref.id);
  const connectorIds = snapshot.connectors.map((ref) => ref.id);

  if (
    sameIds(knowledgeBaseIds, current.knowledgeBaseIds) &&
    sameIds(connectorIds, current.connectorIds)
  ) {
    return null;
  }

  const access =
    await knowledgeSourceAccessControlService.buildAccessControlContext({
      userId,
      organizationId,
    });

  for (const ref of snapshot.knowledgeBases) {
    const kb = await KnowledgeBaseModel.findById(ref.id);
    if (
      !kb ||
      kb.organizationId !== organizationId ||
      !knowledgeSourceAccessControlService.canAccessKnowledgeBase(access, kb)
    ) {
      throw unrestorable(
        `knowledge base "${ref.name}" is not available to you`,
      );
    }
  }

  for (const ref of snapshot.connectors) {
    const connector = await KnowledgeBaseConnectorModel.findById(ref.id);
    if (
      !connector ||
      connector.organizationId !== organizationId ||
      !knowledgeSourceAccessControlService.canAccessConnector(access, connector)
    ) {
      throw unrestorable(`connector "${ref.name}" is not available to you`);
    }
  }

  return { knowledgeBaseIds, connectorIds };
}

/** Set equality over string collections whose order carries no meaning. */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * A restore is refused as a whole, so every rejection reads the same way and
 * names the reference that blocked it.
 */
function unrestorable(reason: string): ApiError {
  return new ApiError(400, `Cannot restore this version: ${reason}`);
}
