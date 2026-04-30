import { and, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  AgentModel,
  AgentToolModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
} from "@/models";
import type { Agent } from "@/types";
import {
  type AgentExportPayload,
  AgentExportPayloadSchema,
  type ImportWarning,
} from "@/types/agent-export";
import type { ConnectorType } from "@/types/knowledge-connector";

/**
 * Result of an agent import operation.
 */
export type ImportResult = {
  agent: Agent;
  warnings: ImportWarning[];
};

/**
 * Import an agent from a portable JSON payload.
 *
 * Design principles:
 * - Always create with `personal` scope (security: prevent privilege escalation)
 * - Resolve all references by human-readable names, not UUIDs
 * - Never fail on missing tools/KBs/connectors/delegations — return soft warnings
 * - Append `(imported)` to agent name if a collision is detected
 * - `llmApiKeyId` and `identityProviderId` are explicitly set to null (not portable)
 */
export async function importAgentFromPayload(
  payload: AgentExportPayload,
  userId: string,
  organizationId: string,
): Promise<ImportResult> {
  const warnings: ImportWarning[] = [];

  // 1. Validate payload against schema
  const parsed = AgentExportPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Invalid import payload: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  const data = parsed.data;

  // 2. Version check
  if (data.version !== "1") {
    throw new Error(
      `Unsupported import version "${data.version}". Only version "1" is supported.`,
    );
  }

  // 3. Resolve name (deduplicate if collision)
  const agentName = await resolveAgentName(data.agent.name, organizationId);

  // 4. Resolve labels
  const labels = data.labels.map((l) => ({ key: l.key, value: l.value }));

  // 5. Resolve knowledge bases (by name)
  const knowledgeBaseIds = await resolveKnowledgeBases(
    data.knowledgeBases,
    organizationId,
    warnings,
  );

  // 6. Resolve connectors (by name + type)
  const connectorIds = await resolveConnectors(
    data.connectors,
    organizationId,
    warnings,
  );

  // 7. Create the agent
  const agent = await AgentModel.create(
    {
      name: agentName,
      agentType: "agent",
      description: data.agent.description,
      systemPrompt: data.agent.systemPrompt,
      icon: data.agent.icon,
      scope: "personal", // Always personal on import
      considerContextUntrusted: data.agent.considerContextUntrusted,
      toolAssignmentMode: data.agent.toolAssignmentMode as
        | "automatic"
        | "manual",
      toolExposureMode: data.agent.toolExposureMode as
        | "full"
        | "search_and_run_only",
      llmModel: data.agent.llmModel,
      llmApiKeyId: null,
      identityProviderId: null,
      incomingEmailEnabled: data.agent.incomingEmailEnabled,
      incomingEmailSecurityMode: data.agent.incomingEmailSecurityMode as
        | "private"
        | "internal"
        | "public",
      incomingEmailAllowedDomain: data.agent.incomingEmailAllowedDomain,
      passthroughHeaders: data.agent.passthroughHeaders,
      organizationId,
      teams: [],
      labels,
      knowledgeBaseIds,
      connectorIds,
      suggestedPrompts: data.suggestedPrompts,
    },
    userId,
  );

  // 8. Resolve and assign tools (after agent creation)
  await resolveAndAssignTools(data.tools, agent.id, warnings);

  // 9. Resolve and assign delegations (after agent creation)
  await resolveAndAssignDelegations(
    data.delegations,
    agent.id,
    organizationId,
    warnings,
  );

  // Re-fetch the fully populated agent to return
  const populatedAgent = await AgentModel.findById(agent.id, userId, true);

  return {
    agent: populatedAgent ?? agent,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve agent name with deduplication.
 * If an agent with the same name already exists in the org, append ` (imported)`.
 * If that also exists, append ` (imported 2)`, ` (imported 3)`, etc.
 */
async function resolveAgentName(
  requestedName: string,
  organizationId: string,
): Promise<string> {
  const existing = await db
    .select({ id: schema.agentsTable.id })
    .from(schema.agentsTable)
    .where(
      and(
        eq(schema.agentsTable.name, requestedName),
        eq(schema.agentsTable.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    return requestedName;
  }

  // Try with (imported) suffix
  let candidate = `${requestedName} (imported)`;
  let counter = 2;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const dup = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.name, candidate),
          eq(schema.agentsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (dup.length === 0) {
      return candidate;
    }

    candidate = `${requestedName} (imported ${counter})`;
    counter++;

    // Safety valve
    if (counter > 100) {
      return `${requestedName} (imported ${Date.now()})`;
    }
  }
}

/**
 * Resolve tool references by catalog name + tool name.
 * Creates agent_tools assignments for all resolved tools.
 * Adds warnings for tools that can't be found.
 */
async function resolveAndAssignTools(
  toolRefs: AgentExportPayload["tools"],
  agentId: string,
  warnings: ImportWarning[],
): Promise<void> {
  if (toolRefs.length === 0) return;

  const assignments: Array<{
    agentId: string;
    toolId: string;
    credentialResolutionMode?: "static" | "dynamic" | "enterprise_managed";
  }> = [];

  for (const ref of toolRefs) {
    const tool = await findToolByReference(ref);

    if (!tool) {
      const location = ref.catalogName
        ? `catalog "${ref.catalogName}"`
        : "local registry";
      warnings.push({
        type: "tool",
        name: ref.toolName,
        message: `Tool "${ref.toolName}" not found in ${location}. Install the MCP server or discover the tool via proxy to assign it.`,
      });
      continue;
    }

    assignments.push({
      agentId,
      toolId: tool.id,
      ...(ref.credentialResolutionMode
        ? { credentialResolutionMode: ref.credentialResolutionMode }
        : {}),
    });
  }

  if (assignments.length > 0) {
    try {
      await AgentToolModel.bulkCreate(assignments);
    } catch (error) {
      logger.warn(
        { agentId, error: String(error) },
        "Failed to bulk-create tool assignments during import",
      );
    }
  }
}

/**
 * Find a tool by its portable reference (catalog name + tool name).
 */
async function findToolByReference(ref: {
  toolName: string;
  catalogName: string | null;
}): Promise<{ id: string } | null> {
  if (ref.catalogName) {
    // Look up tool by catalog name + tool name
    const result = await db
      .select({ id: schema.toolsTable.id })
      .from(schema.toolsTable)
      .innerJoin(
        schema.internalMcpCatalogTable,
        eq(schema.toolsTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(
        and(
          eq(schema.toolsTable.name, ref.toolName),
          eq(schema.internalMcpCatalogTable.name, ref.catalogName),
        ),
      )
      .limit(1);

    if (result.length > 0) {
      return result[0];
    }
  }

  // Fallback: look up by name only (for proxy-sniffed tools or when catalog lookup fails)
  const result = await db
    .select({ id: schema.toolsTable.id })
    .from(schema.toolsTable)
    .where(
      and(
        eq(schema.toolsTable.name, ref.toolName),
        isNull(schema.toolsTable.delegateToAgentId),
      ),
    )
    .limit(1);

  return result[0] ?? null;
}

/**
 * Resolve delegations by target agent name in the same organization.
 * Uses AgentToolModel.assignDelegation() to create the delegation tool + assignment.
 */
async function resolveAndAssignDelegations(
  delegationRefs: AgentExportPayload["delegations"],
  agentId: string,
  organizationId: string,
  warnings: ImportWarning[],
): Promise<void> {
  if (delegationRefs.length === 0) return;

  for (const ref of delegationRefs) {
    const [targetAgent] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.name, ref.targetAgentName),
          eq(schema.agentsTable.organizationId, organizationId),
          eq(schema.agentsTable.agentType, "agent"),
        ),
      )
      .limit(1);

    if (!targetAgent) {
      warnings.push({
        type: "delegation",
        name: ref.targetAgentName,
        message: `Delegation target agent "${ref.targetAgentName}" not found in this organization. Create it first, then add the delegation manually.`,
      });
      continue;
    }

    try {
      await AgentToolModel.assignDelegation(agentId, targetAgent.id);
    } catch (error) {
      logger.warn(
        { agentId, targetAgentName: ref.targetAgentName, error: String(error) },
        "Failed to assign delegation during import",
      );
    }
  }
}

/**
 * Resolve knowledge bases by name in the organization.
 * Returns the IDs of found KBs and adds warnings for missing ones.
 */
async function resolveKnowledgeBases(
  kbRefs: AgentExportPayload["knowledgeBases"],
  organizationId: string,
  warnings: ImportWarning[],
): Promise<string[]> {
  if (kbRefs.length === 0) return [];

  const resolvedIds: string[] = [];

  for (const ref of kbRefs) {
    const kb = await KnowledgeBaseModel.findByName(ref.name, organizationId);

    if (!kb) {
      warnings.push({
        type: "knowledgeBase",
        name: ref.name,
        message: `Knowledge base "${ref.name}" not found in this organization. Create it first, then assign it to the agent manually.`,
      });
      continue;
    }

    resolvedIds.push(kb.id);
  }

  return resolvedIds;
}

/**
 * Resolve connectors by name + type in the organization.
 * Returns the IDs of found connectors and adds warnings for missing ones.
 */
async function resolveConnectors(
  connectorRefs: AgentExportPayload["connectors"],
  organizationId: string,
  warnings: ImportWarning[],
): Promise<string[]> {
  if (connectorRefs.length === 0) return [];

  const resolvedIds: string[] = [];

  for (const ref of connectorRefs) {
    const connector = await KnowledgeBaseConnectorModel.findByNameAndType(
      ref.name,
      ref.connectorType as ConnectorType,
      organizationId,
    );

    if (!connector) {
      warnings.push({
        type: "connector",
        name: ref.name,
        message: `Connector "${ref.name}" (type: ${ref.connectorType}) not found in this organization. Configure it first, then assign it to the agent manually.`,
      });
      continue;
    }

    resolvedIds.push(connector.id);
  }

  return resolvedIds;
}
