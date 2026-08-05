import {
  getResourceForAgentType,
  IncomingEmailSecurityModeSchema,
} from "@archestra/shared";
import { userHasPermission } from "@/auth";
import { knowledgeSourceAccessControlService } from "@/knowledge-base";
import logger from "@/logging";
import {
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
import { assignToolToAgent } from "@/services/agent-tool-assignment";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import { assertCanAssignEnvironment } from "@/services/environments/environment";
import type { Agent, UpdateAgent } from "@/types";
import {
  ApiError,
  CredentialResolutionModeSchema,
  ToolExposureModeSchema,
} from "@/types";
import type { AgentConfigSnapshot } from "@/types/agent-version";
import { InsertHookFileSchema } from "@/types/hook";

/**
 * Restore an agent's config to an earlier version by replaying its immutable
 * snapshot forward: the restored config becomes a NEW head version, so nothing
 * in the history is rewritten (git-revert semantics).
 *
 * Ordering is load-bearing:
 * 1. Read the snapshot FIRST, so a restore of a pruned or foreign version 404s
 *    before this mints anything.
 * 2. Fork, which does double duty. Version coverage is best-effort at operation
 *    boundaries, so live config can be ahead of the head snapshot; forking
 *    before any write records the true pre-restore state as a recoverable
 *    version. Passing `baseVersion` also makes it the compare-and-set.
 * 3. Resolve every snapshot reference up front, so referents deleted or moved
 *    out of the caller's reach since capture surface as `skipped` entries
 *    rather than mid-replay failures.
 * 4. Replay tools → hooks → scalars (incl. the accessAllTools flip, whose off→on
 *    pre-fill must see the restored assignment set) → exclusions (an explicit
 *    full replace that overrides that pre-fill), all with `deferVersionFork` so
 *    one restore produces exactly one new version.
 *
 * The replay spans several write paths that each own their transaction, so it
 * is deliberately NOT atomic — same tolerance as bulk assignment: a partial
 * failure leaves a mixed config that the next fork captures, and the restore is
 * retryable because the source version is immutable.
 */
export async function restoreAgentVersion(params: {
  agentId: string;
  version: number;
  baseVersion?: number;
  userId: string;
  organizationId: string;
}): Promise<{ agent: Agent; skipped: string[] }> {
  const { agentId, version, userId, organizationId } = params;

  const versionRow = await AgentVersionModel.findByAgentAndVersion({
    agentId,
    version,
    organizationId,
  });
  if (!versionRow) {
    throw new ApiError(404, `Agent has no version ${version}`);
  }
  const snapshot = versionRow.snapshot;

  // Throws 409 (`agent_version_conflict`) when the head moved past baseVersion.
  const fork = await AgentVersionModel.forkIfChanged(agentId, {
    expectedLatestVersion: params.baseVersion,
  });
  if (!fork) {
    throw new ApiError(404, "Agent not found");
  }

  const current = await AgentModel.findById(agentId, userId, true);
  if (!current) {
    throw new ApiError(404, "Agent not found");
  }

  const skipped: string[] = [];

  // Resolve references before the first write so unrestorable ones are recorded
  // instead of failing the replay.
  const [llmSelection, environmentSelection, knowledge] = await Promise.all([
    resolveLlmSelection({ snapshot, organizationId, skipped }),
    resolveEnvironment({
      snapshot,
      userId,
      organizationId,
      agentType: current.agentType,
      skipped,
    }),
    resolveKnowledgeSources({ snapshot, userId, organizationId, skipped }),
  ]);

  await replayTools({ agentId, snapshot, skipped });

  await HookFileModel.replaceForAgent({
    agentId,
    organizationId,
    hooks: buildHookRows({ agentId, organizationId, snapshot, skipped }),
    deferVersionFork: true,
  });

  const scalars: Partial<UpdateAgent> = {
    name: snapshot.name,
    description: snapshot.description,
    icon: snapshot.icon,
    systemPrompt: snapshot.systemPrompt,
    considerContextUntrusted: snapshot.considerContextUntrusted,
    accessAllTools: snapshot.accessAllTools,
    accessAllSubagents: snapshot.accessAllSubagents,
    passthroughHeaders: snapshot.passthroughHeaders,
    incomingEmailEnabled: snapshot.incomingEmailEnabled,
    incomingEmailAllowedDomain: snapshot.incomingEmailAllowedDomain,
    suggestedPrompts: snapshot.suggestedPrompts,
    knowledgeBaseIds: knowledge.knowledgeBaseIds,
    connectorIds: knowledge.connectorIds,
    ...llmSelection,
    ...environmentSelection,
    // identityProviderId is captured in the snapshot but deliberately not
    // replayed: migration 0215 cleared it for agent_type='agent' and no write
    // path sets it anymore (clone and import both null it), so there is no
    // value to restore. Replaying the raw FK would also 500 on an IdP deleted
    // since the snapshot, unlike every other reference here which is resolved
    // and reported via `skipped`.
  };

  // Snapshots keep enum-ish fields as plain strings so history outlives enum
  // changes; a value the current schema no longer knows keeps the live one
  // rather than being cast blindly into a typed column.
  const exposureMode = ToolExposureModeSchema.safeParse(
    snapshot.toolExposureMode,
  );
  if (exposureMode.success) {
    scalars.toolExposureMode = exposureMode.data;
  } else {
    skipped.push(`Tool exposure mode "${snapshot.toolExposureMode}"`);
  }
  const emailMode = IncomingEmailSecurityModeSchema.safeParse(
    snapshot.incomingEmailSecurityMode,
  );
  if (emailMode.success) {
    scalars.incomingEmailSecurityMode = emailMode.data;
  } else {
    skipped.push(
      `Incoming email security mode "${snapshot.incomingEmailSecurityMode}"`,
    );
  }

  // The off→on All-tools pre-fill inside update sees the already-replayed
  // assignment set; the explicit exclusion replace below then overrides the
  // pre-fill with the snapshot's exact exclusion state.
  const updated = await AgentModel.update(agentId, scalars, {
    deferVersionFork: true,
  });
  if (!updated) {
    throw new ApiError(404, "Agent not found");
  }

  await replayExclusions({ agentId, organizationId, snapshot });

  // One fork for the whole replay. Best-effort like every post-commit fork: the
  // restored config is already live, so a fork failure must not fail the
  // restore — the next config write captures the state instead.
  await AgentVersionModel.forkIfChangedBestEffort(agentId);

  // Re-read rather than returning `updated`: the deferred update left its
  // `latestVersion` at the pre-restore head, and clients anchor their next
  // restore on the value this response carries.
  const agent = await AgentModel.findById(agentId, userId, true);
  if (!agent) {
    throw new ApiError(404, "Agent not found");
  }

  logger.info(
    { agentId, restoredFromVersion: version, skippedCount: skipped.length },
    "Restored agent config version",
  );

  return { agent, skipped };
}

// === Internal helpers ===

/**
 * A model and its API key are a pair: restore both or neither (the UpdateAgent
 * invariant the update route enforces). If either referent is gone, the agent's
 * current pair is kept — never degrade a working LLM config, and never write
 * the half pair that independent filtering would produce.
 */
async function resolveLlmSelection(params: {
  snapshot: AgentConfigSnapshot;
  organizationId: string;
  skipped: string[];
}): Promise<Partial<UpdateAgent>> {
  const { snapshot, organizationId, skipped } = params;
  if (snapshot.model === null && snapshot.llmApiKey === null) {
    return { modelId: null, llmApiKeyId: null };
  }
  if (snapshot.model === null || snapshot.llmApiKey === null) {
    // Defensive — the snapshot builder captures the pair whole.
    skipped.push("LLM configuration (incomplete in this version)");
    return {};
  }

  const [model, apiKey] = await Promise.all([
    ModelModel.findById(snapshot.model.id),
    LlmProviderApiKeyModel.findById(snapshot.llmApiKey.id),
  ]);
  if (!model) {
    skipped.push(`Model "${snapshot.model.externalId}"`);
    return {};
  }
  if (!apiKey || apiKey.organizationId !== organizationId) {
    skipped.push(`API key "${snapshot.llmApiKey.name}"`);
    return {};
  }
  return { modelId: snapshot.model.id, llmApiKeyId: snapshot.llmApiKey.id };
}

/**
 * Restoring an environment binding is gated by the caller's CURRENT
 * deploy-to-restricted permission, exactly like setting it via update — a
 * binding that was legal at capture may not be legal for this caller today.
 */
async function resolveEnvironment(params: {
  snapshot: AgentConfigSnapshot;
  userId: string;
  organizationId: string;
  agentType: Agent["agentType"];
  skipped: string[];
}): Promise<Partial<UpdateAgent>> {
  const { snapshot, userId, organizationId, agentType, skipped } = params;
  if (snapshot.environmentId === null) {
    return { environmentId: null };
  }
  try {
    const canDeployToRestricted = await userHasPermission(
      userId,
      organizationId,
      getResourceForAgentType(agentType),
      "deploy-to-restricted",
    );
    await assertCanAssignEnvironment({
      environmentId: snapshot.environmentId,
      organizationId,
      canDeployToRestricted,
    });
  } catch {
    skipped.push("Environment binding");
    return {};
  }
  return { environmentId: snapshot.environmentId };
}

/**
 * Knowledge access is enforced against the restoring caller, mirroring the
 * update route: sources that vanished or fell out of the caller's reach are
 * dropped from the restored set.
 */
async function resolveKnowledgeSources(params: {
  snapshot: AgentConfigSnapshot;
  userId: string;
  organizationId: string;
  skipped: string[];
}): Promise<{ knowledgeBaseIds: string[]; connectorIds: string[] }> {
  const { snapshot, userId, organizationId, skipped } = params;
  if (
    snapshot.knowledgeBases.length === 0 &&
    snapshot.connectors.length === 0
  ) {
    return { knowledgeBaseIds: [], connectorIds: [] };
  }

  const access =
    await knowledgeSourceAccessControlService.buildAccessControlContext({
      userId,
      organizationId,
    });

  const knowledgeBaseIds: string[] = [];
  for (const ref of snapshot.knowledgeBases) {
    const kb = await KnowledgeBaseModel.findById(ref.id);
    if (
      kb &&
      kb.organizationId === organizationId &&
      knowledgeSourceAccessControlService.canAccessKnowledgeBase(access, kb)
    ) {
      knowledgeBaseIds.push(ref.id);
    } else {
      skipped.push(`Knowledge base "${ref.name}"`);
    }
  }

  const connectorIds: string[] = [];
  for (const ref of snapshot.connectors) {
    const connector = await KnowledgeBaseConnectorModel.findById(ref.id);
    if (
      connector &&
      connector.organizationId === organizationId &&
      knowledgeSourceAccessControlService.canAccessConnector(access, connector)
    ) {
      connectorIds.push(ref.id);
    } else {
      skipped.push(`Connector "${ref.name}"`);
    }
  }

  return { knowledgeBaseIds, connectorIds };
}

/**
 * Converge the agent's tool assignments to the snapshot's set: assign (or
 * re-credential) every snapshot tool that still validates, then unassign
 * everything the snapshot does not carry. Failures are recorded, not fatal —
 * `assignToolToAgent` re-runs its assignment validation, so a tool that has
 * since been deleted, left pending discovery, or lost the installed server its
 * catalog requires is skipped instead of failing the replay.
 *
 * The unassign pass keys off the SNAPSHOT, not off what re-assigned cleanly:
 * "the version does not want this tool" and "this tool can no longer be
 * assigned" are different states and only the first is a reason to revoke. A
 * static assignment outlives the installation it pinned (`mcp_server_id` is
 * `ON DELETE SET NULL`), so a live, working tool can fail the assign validator
 * while sitting in both the current config and the snapshot — dropping it there
 * would make a restore strip tool access the target version explicitly had, and
 * would do it even when restoring the agent's own current version. Same rule as
 * `resolveLlmSelection`: an unrestorable reference keeps the live value.
 *
 * That validation is NOT caller-scoped: it resolves the MCP-server ownership
 * context from the *agent* (`getAssignmentTargetContext`), never from the user
 * running the restore. The route gates the whole operation on the same
 * agent-type `update` + scope checks the single-tool assign route applies, so a
 * restore grants exactly what a direct assign would — but do not read this loop
 * as a per-caller tool check, because there isn't one.
 */
async function replayTools(params: {
  agentId: string;
  snapshot: AgentConfigSnapshot;
  skipped: string[];
}): Promise<void> {
  const { agentId, snapshot, skipped } = params;

  const restoredToolIds = new Set<string>();
  for (const ref of snapshot.tools) {
    const tool = await ToolModel.findById(ref.toolId);
    if (!tool) {
      skipped.push(`Tool "${ref.name}"`);
      continue;
    }

    // Snapshots keep the mode as a plain string so history outlives enum
    // changes. A value the current schema no longer knows falls back to the
    // `static` default inside `assignToolToAgent` — report it, because the tool
    // then lands under a DIFFERENT credential binding than the version
    // recorded, and a silent downgrade is exactly what a restore must not do.
    const mode = CredentialResolutionModeSchema.safeParse(
      ref.credentialResolutionMode,
    );
    if (!mode.success) {
      skipped.push(
        `Credential mode "${ref.credentialResolutionMode}" for tool "${ref.name}"`,
      );
    }
    try {
      const result = await assignToolToAgent({
        agentId,
        toolId: ref.toolId,
        mcpServerId: ref.mcpServerId,
        credentialResolutionMode: mode.success ? mode.data : undefined,
        deferVersionFork: true,
      });
      if (result && result !== "duplicate" && result !== "updated") {
        skipped.push(`Tool "${ref.name}"`);
        continue;
      }
    } catch (error) {
      logger.warn(
        { agentId, toolId: ref.toolId, error: String(error) },
        "Failed to assign tool during version restore",
      );
      skipped.push(`Tool "${ref.name}"`);
      continue;
    }
    restoredToolIds.add(ref.toolId);
  }

  const snapshotToolIds = new Set(snapshot.tools.map((ref) => ref.toolId));
  const currentToolIds = await AgentToolModel.findToolIdsByAgent(agentId);
  for (const toolId of currentToolIds) {
    if (!restoredToolIds.has(toolId) && !snapshotToolIds.has(toolId)) {
      await AgentToolModel.delete({ agentId, toolId, deferVersionFork: true });
    }
  }
}

/**
 * Full replace of both exclusion sets from the snapshot. Ids whose referent is
 * gone are dropped silently — an exclusion of a deleted tool or agent is inert,
 * so losing it changes nothing about the restored behavior and it would only
 * add noise to `skipped`.
 */
async function replayExclusions(params: {
  agentId: string;
  organizationId: string;
  snapshot: AgentConfigSnapshot;
}): Promise<void> {
  const { agentId, organizationId, snapshot } = params;

  const excludedToolIds: string[] = [];
  for (const ref of snapshot.excludedTools) {
    const tool = await ToolModel.findById(ref.toolId);
    if (tool) {
      excludedToolIds.push(ref.toolId);
    }
  }
  await agentToolExclusionsService.replaceExclusions({
    agentId,
    organizationId,
    excludedToolIds,
    deferVersionFork: true,
  });

  // The subagent replace validates and drops stale targets itself.
  await agentSubagentExclusionsService.replaceExclusions({
    agentId,
    organizationId,
    excludedSubagentIds: snapshot.excludedSubagents.map((ref) => ref.agentId),
    deferVersionFork: true,
  });
}

/**
 * Snapshot hooks are plain strings because history must outlive enum changes; a
 * hook the current schema rejects (retired event, invalid file name) is skipped
 * rather than failing the replay.
 */
function buildHookRows(params: {
  agentId: string;
  organizationId: string;
  snapshot: AgentConfigSnapshot;
  skipped: string[];
}) {
  const { agentId, organizationId, snapshot, skipped } = params;
  const rows = [];
  for (const hook of snapshot.hooks) {
    const parsed = InsertHookFileSchema.safeParse({
      agentId,
      organizationId,
      event: hook.event,
      fileName: hook.fileName,
      content: hook.content,
      requirements: hook.requirements,
      enabled: hook.enabled,
    });
    if (parsed.success) {
      rows.push(parsed.data);
    } else {
      skipped.push(`Hook "${hook.fileName}"`);
    }
  }
  return rows;
}
