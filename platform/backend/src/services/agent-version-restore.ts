import {
  getResourceForAgentType,
  IncomingEmailSecurityModeSchema,
} from "@archestra/shared";
import { userHasPermission } from "@/auth";
import config from "@/config";
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
import type { Agent, AgentType, UpdateAgent } from "@/types";
import {
  ApiError,
  CredentialResolutionModeSchema,
  ToolExposureModeSchema,
} from "@/types";
import type {
  AgentConfigSnapshot,
  RestoreVersionWarning,
} from "@/types/agent-version";
import { type InsertHookFile, InsertHookFileSchema } from "@/types/hook";

/**
 * Restore an agent's config to an earlier version by replaying its immutable
 * snapshot forward: the restored config becomes a NEW head version, so nothing
 * in the history is rewritten (git-revert semantics).
 *
 * Ordering inside the replay is load-bearing:
 * 1. Fork FIRST. Version coverage is best-effort at operation boundaries, so
 *    the live config can be ahead of the head snapshot; forking before any
 *    write records the true pre-restore state as a recoverable version. The
 *    fork also serves as the concurrency check — if the head is not where the
 *    client previewed it, the restore 409s before touching anything.
 * 2. Resolve every snapshot reference up front. Referents deleted or moved out
 *    of the caller's reach since capture downgrade to soft warnings (the agent
 *    import contract): list items are skipped, singular references keep the
 *    agent's current value.
 * 3. Replay tools → scalars (incl. the accessAllTools flip, whose off→on
 *    pre-fill must see the restored assignment set) → exclusions (an explicit
 *    full replace that overrides the pre-fill) → hooks, all with
 *    `deferVersionFork` so one restore produces exactly one new version.
 *
 * The replay spans several write paths that each own their transaction, so it
 * is deliberately NOT atomic — same tolerance as bulk assignment: a partial
 * failure leaves a mixed config that the next fork captures, and the restore
 * is retryable because the source version is immutable.
 */
export async function restoreAgentVersion(params: {
  agentId: string;
  version: number;
  expectedHeadVersion?: number;
  userId: string;
  organizationId: string;
}): Promise<{ agent: Agent; warnings: RestoreVersionWarning[] }> {
  const { agentId, version, userId, organizationId } = params;

  const fork = await AgentVersionModel.forkIfChanged(agentId);
  if (!fork) {
    throw new ApiError(404, "Agent not found");
  }
  if (
    params.expectedHeadVersion !== undefined &&
    fork.version !== params.expectedHeadVersion
  ) {
    throw new ApiError(
      409,
      `Agent config changed since the preview (head is now v${fork.version}). Review the latest version and retry.`,
      "agent_version_conflict",
    );
  }

  const versionRow = await AgentVersionModel.findByAgentAndVersion({
    agentId,
    version,
    organizationId,
  });
  if (!versionRow) {
    throw new ApiError(404, `Agent has no version ${version}`);
  }
  const snapshot = versionRow.snapshot;

  const current = await AgentModel.findById(agentId, userId, true);
  if (!current) {
    throw new ApiError(404, "Agent not found");
  }

  const warnings: RestoreVersionWarning[] = [];

  // Resolve references before the first write so unrestorable ones surface as
  // warnings instead of mid-replay failures.
  const [llmSelection, identitySelection, environmentSelection, knowledge] =
    await Promise.all([
      resolveLlmSelection({ snapshot, organizationId, warnings }),
      resolveIdentityProvider({ snapshot, organizationId, warnings }),
      resolveEnvironment({
        snapshot,
        userId,
        organizationId,
        agentType: current.agentType,
        warnings,
      }),
      resolveKnowledgeSources({ snapshot, userId, organizationId, warnings }),
    ]);

  await replayTools({ agentId, snapshot, warnings });

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
    ...identitySelection,
    ...environmentSelection,
  };

  // Snapshots keep enum-ish fields as plain strings so history outlives enum
  // changes; a value the current schema no longer knows keeps the live one.
  const exposureMode = ToolExposureModeSchema.safeParse(
    snapshot.toolExposureMode,
  );
  if (exposureMode.success) {
    scalars.toolExposureMode = exposureMode.data;
  } else {
    warnings.push({
      type: "config",
      name: "toolExposureMode",
      message: `Tool exposure mode "${snapshot.toolExposureMode}" is no longer supported; kept the current setting.`,
    });
  }
  const emailMode = IncomingEmailSecurityModeSchema.safeParse(
    snapshot.incomingEmailSecurityMode,
  );
  if (emailMode.success) {
    scalars.incomingEmailSecurityMode = emailMode.data;
  } else {
    warnings.push({
      type: "config",
      name: "incomingEmailSecurityMode",
      message: `Incoming email security mode "${snapshot.incomingEmailSecurityMode}" is no longer supported; kept the current setting.`,
    });
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

  await HookFileModel.replaceForAgent({
    agentId,
    organizationId,
    hooks: buildHookRows({ agentId, organizationId, snapshot, warnings }),
    deferVersionFork: true,
  });

  // One fork for the whole replay. Best-effort like every post-commit fork: the
  // restored config is already live, so a fork failure must not fail the
  // restore — the next config write captures the state instead.
  await AgentVersionModel.forkIfChangedBestEffort(agentId);

  const agent = await AgentModel.findById(agentId, userId, true);
  if (!agent) {
    throw new ApiError(404, "Agent not found");
  }

  logger.info(
    { agentId, restoredFromVersion: version, warningCount: warnings.length },
    "Restored agent config version",
  );

  return { agent, warnings };
}

// === Internal helpers ===

/**
 * A model and its API key are a pair: restore both or neither (the UpdateAgent
 * invariant). If either referent is gone, the agent's current pair is kept —
 * never degrade a working LLM config for an unrestorable reference.
 */
async function resolveLlmSelection(params: {
  snapshot: AgentConfigSnapshot;
  organizationId: string;
  warnings: RestoreVersionWarning[];
}): Promise<Partial<UpdateAgent>> {
  const { snapshot, organizationId, warnings } = params;
  if (snapshot.model === null && snapshot.llmApiKey === null) {
    return { modelId: null, llmApiKeyId: null };
  }
  if (snapshot.model === null || snapshot.llmApiKey === null) {
    // A half pair cannot be written back; defensive — the snapshot builder
    // captures pairs whole.
    warnings.push({
      type: "model",
      name: snapshot.model?.externalId ?? snapshot.llmApiKey?.name ?? "model",
      message:
        "The version's model and API key are incomplete; kept the current LLM configuration.",
    });
    return {};
  }

  const [model, apiKey] = await Promise.all([
    ModelModel.findById(snapshot.model.id),
    LlmProviderApiKeyModel.findById(snapshot.llmApiKey.id),
  ]);
  if (!model) {
    warnings.push({
      type: "model",
      name: snapshot.model.externalId,
      message: `Model "${snapshot.model.externalId}" no longer exists; kept the current LLM configuration.`,
    });
    return {};
  }
  if (!apiKey || apiKey.organizationId !== organizationId) {
    warnings.push({
      type: "llmApiKey",
      name: snapshot.llmApiKey.name,
      message: `API key "${snapshot.llmApiKey.name}" no longer exists; kept the current LLM configuration.`,
    });
    return {};
  }
  return { modelId: snapshot.model.id, llmApiKeyId: snapshot.llmApiKey.id };
}

/**
 * Identity providers are an enterprise feature, so their model is loaded
 * conditionally — an OSS build never bundles it, and a snapshot referencing a
 * provider is unrestorable there (the reference is kept-current + warned, the
 * same downgrade as a deleted provider).
 */
async function resolveIdentityProvider(params: {
  snapshot: AgentConfigSnapshot;
  organizationId: string;
  warnings: RestoreVersionWarning[];
}): Promise<Partial<UpdateAgent>> {
  const { snapshot, organizationId, warnings } = params;
  if (snapshot.identityProviderId === null) {
    return { identityProviderId: null };
  }
  if (config.enterpriseFeatures.core) {
    // biome-ignore lint/style/noRestrictedImports: conditional EE import, never runs in OSS builds
    const idpModule = await import("../models/identity-provider.ee");
    const provider = await idpModule.default.findById(
      snapshot.identityProviderId,
      organizationId,
    );
    if (provider) {
      return { identityProviderId: snapshot.identityProviderId };
    }
  }
  warnings.push({
    type: "identityProvider",
    name: snapshot.identityProviderId,
    message:
      "The version's identity provider no longer exists; kept the current one.",
  });
  return {};
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
  agentType: AgentType;
  warnings: RestoreVersionWarning[];
}): Promise<Partial<UpdateAgent>> {
  const { snapshot, userId, organizationId, agentType, warnings } = params;
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
    warnings.push({
      type: "environment",
      name: snapshot.environmentId,
      message:
        "The version's environment no longer exists or cannot be assigned by you; kept the current one.",
    });
    return {};
  }
  return { environmentId: snapshot.environmentId };
}

/**
 * Knowledge access is enforced against the restoring caller, mirroring the
 * UpdateAgent route: sources that vanished or fell out of the caller's reach
 * are dropped from the restored set with a warning.
 */
async function resolveKnowledgeSources(params: {
  snapshot: AgentConfigSnapshot;
  userId: string;
  organizationId: string;
  warnings: RestoreVersionWarning[];
}): Promise<{ knowledgeBaseIds: string[]; connectorIds: string[] }> {
  const { snapshot, userId, organizationId, warnings } = params;
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
      warnings.push({
        type: "knowledgeBase",
        name: ref.name,
        message: `Knowledge base "${ref.name}" no longer exists or is not accessible to you; skipped.`,
      });
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
      warnings.push({
        type: "connector",
        name: ref.name,
        message: `Connector "${ref.name}" no longer exists or is not accessible to you; skipped.`,
      });
    }
  }

  return { knowledgeBaseIds, connectorIds };
}

/**
 * Converge the agent's tool assignments to the snapshot's set: assign (or
 * re-credential) every snapshot tool that still validates, then unassign
 * everything the snapshot does not carry. Failures downgrade to warnings —
 * `assignToolToAgent` re-runs assignment validation against the caller's
 * current world, so a tool on a server the caller can no longer reach is
 * skipped, not fatal.
 */
async function replayTools(params: {
  agentId: string;
  snapshot: AgentConfigSnapshot;
  warnings: RestoreVersionWarning[];
}): Promise<void> {
  const { agentId, snapshot, warnings } = params;

  const restoredToolIds = new Set<string>();
  for (const ref of snapshot.tools) {
    const tool = await ToolModel.findById(ref.toolId);
    if (!tool) {
      warnings.push({
        type: "tool",
        name: ref.name,
        message: `Tool "${ref.name}" no longer exists; skipped.`,
      });
      continue;
    }

    const mode = CredentialResolutionModeSchema.safeParse(
      ref.credentialResolutionMode,
    );
    try {
      const result = await assignToolToAgent({
        agentId,
        toolId: ref.toolId,
        mcpServerId: ref.mcpServerId,
        credentialResolutionMode: mode.success ? mode.data : undefined,
        deferVersionFork: true,
      });
      if (result && result !== "duplicate" && result !== "updated") {
        warnings.push({
          type: "tool",
          name: ref.name,
          message: `Tool "${ref.name}" could not be assigned: ${result.error.message}`,
        });
        continue;
      }
    } catch (error) {
      logger.warn(
        { agentId, toolId: ref.toolId, error: String(error) },
        "Failed to assign tool during version restore",
      );
      warnings.push({
        type: "tool",
        name: ref.name,
        message: `Tool "${ref.name}" could not be assigned due to an unexpected error.`,
      });
      continue;
    }
    restoredToolIds.add(ref.toolId);
  }

  const currentToolIds = await AgentToolModel.findToolIdsByAgent(agentId);
  for (const toolId of currentToolIds) {
    if (!restoredToolIds.has(toolId)) {
      await AgentToolModel.delete({ agentId, toolId, deferVersionFork: true });
    }
  }
}

/**
 * Full replace of both exclusion sets from the snapshot. Ids whose referent is
 * gone are dropped silently — an exclusion of a deleted tool or agent is inert,
 * so losing it changes nothing about the restored behavior.
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
 * Snapshot hooks are plain strings for the same enum-outlives-history reason as
 * scalar fields; a hook the current schema rejects (retired event, invalid file
 * name) is skipped with a warning rather than failing the replay.
 */
function buildHookRows(params: {
  agentId: string;
  organizationId: string;
  snapshot: AgentConfigSnapshot;
  warnings: RestoreVersionWarning[];
}): InsertHookFile[] {
  const { agentId, organizationId, snapshot, warnings } = params;
  const rows: InsertHookFile[] = [];
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
      warnings.push({
        type: "hook",
        name: hook.fileName,
        message: `Hook "${hook.fileName}" is no longer valid and was skipped.`,
      });
    }
  }
  return rows;
}
