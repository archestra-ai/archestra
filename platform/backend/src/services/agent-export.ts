import {
  parseFullToolName,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
} from "@shared";
import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { Agent } from "@/types";
import type { AgentExportPayload } from "@/types/agent-export";

/**
 * Serialize an agent and all its associations into a portable JSON payload
 * that can be imported into another Archestra instance.
 *
 * Design principles:
 * - Use human-readable names, never internal UUIDs
 * - Strip secrets (API keys, identity providers, author info)
 * - Include `llmModel` as informational text (not auto-configured on import)
 * - Include `credentialResolutionMode` from the agent_tools junction table
 */
export async function serializeAgentForExport(
  agent: Agent,
): Promise<AgentExportPayload> {
  const [
    toolReferences,
    delegationReferences,
    kbReferences,
    connectorReferences,
  ] = await Promise.all([
    resolveToolReferences(agent),
    resolveDelegationReferences(agent),
    resolveKnowledgeBaseReferences(
      agent.knowledgeBaseIds,
      agent.organizationId,
    ),
    resolveConnectorReferences(agent.connectorIds, agent.organizationId),
  ]);

  return {
    version: "1",
    exportedAt: new Date().toISOString(),
    sourceInstance: null,

    agent: {
      name: agent.name,
      agentType: "agent",
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      icon: agent.icon,
      scope: agent.scope,
      considerContextUntrusted: agent.considerContextUntrusted,
      toolAssignmentMode: agent.toolAssignmentMode,
      toolExposureMode: agent.toolExposureMode,
      llmModel: agent.llmModel,
      incomingEmailEnabled: agent.incomingEmailEnabled,
      incomingEmailSecurityMode: agent.incomingEmailSecurityMode,
      incomingEmailAllowedDomain: agent.incomingEmailAllowedDomain,
      passthroughHeaders: agent.passthroughHeaders,
    },

    labels: agent.labels.map((l) => ({ key: l.key, value: l.value })),

    suggestedPrompts: (agent.suggestedPrompts ?? []).map((p) => ({
      summaryTitle: p.summaryTitle,
      prompt: p.prompt,
    })),

    tools: toolReferences,
    delegations: delegationReferences,
    knowledgeBases: kbReferences,
    connectors: connectorReferences,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve non-delegation tools to portable references.
 * Joins against the MCP catalog to get human-readable catalog names and
 * reads the agent_tools junction table for assignment-level settings.
 */
async function resolveToolReferences(
  agent: Agent,
): Promise<AgentExportPayload["tools"]> {
  const hasKnowledgeSources =
    agent.knowledgeBaseIds.length > 0 || agent.connectorIds.length > 0;
  const nonDelegationTools = agent.tools.filter(
    (t) =>
      !t.delegateToAgentId &&
      (hasKnowledgeSources || !isQueryKnowledgeSourcesTool(t.name)),
  );
  if (nonDelegationTools.length === 0) return [];

  // Batch-fetch catalog names for tools with a catalogId
  const catalogIds = [
    ...new Set(
      nonDelegationTools
        .map((t) => t.catalogId)
        .filter((id): id is string => id !== null),
    ),
  ];

  const catalogNameMap = new Map<string, string>();
  if (catalogIds.length > 0) {
    const catalogRows = await db
      .select({
        id: schema.internalMcpCatalogTable.id,
        name: schema.internalMcpCatalogTable.name,
      })
      .from(schema.internalMcpCatalogTable)
      .where(inArray(schema.internalMcpCatalogTable.id, catalogIds));

    for (const row of catalogRows) {
      catalogNameMap.set(row.id, row.name);
    }
  }

  // Batch-fetch credential resolution modes from agent_tools junction table
  const toolIds = nonDelegationTools.map((t) => t.id);
  const junctionRows = await db
    .select({
      toolId: schema.agentToolsTable.toolId,
      credentialResolutionMode: schema.agentToolsTable.credentialResolutionMode,
    })
    .from(schema.agentToolsTable)
    .where(
      and(
        eq(schema.agentToolsTable.agentId, agent.id),
        inArray(schema.agentToolsTable.toolId, toolIds),
      ),
    );

  const credentialModeMap = new Map<string, string>();
  for (const row of junctionRows) {
    credentialModeMap.set(row.toolId, row.credentialResolutionMode);
  }

  return nonDelegationTools.map((tool) => ({
    toolName: tool.name,
    catalogName: tool.catalogId
      ? (catalogNameMap.get(tool.catalogId) ?? null)
      : null,
    credentialResolutionMode: credentialModeMap.get(tool.id) as
      | "static"
      | "dynamic"
      | "enterprise_managed"
      | undefined,
  }));
}

function isQueryKnowledgeSourcesTool(toolName: string): boolean {
  return (
    parseFullToolName(toolName).toolName ===
    TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME
  );
}

/**
 * Resolve delegation tools to portable references (target agent names).
 */
async function resolveDelegationReferences(
  agent: Agent,
): Promise<AgentExportPayload["delegations"]> {
  const delegationTools = agent.tools.filter((t) => t.delegateToAgentId);
  if (delegationTools.length === 0) return [];

  const targetAgentIds = delegationTools
    .map((t) => t.delegateToAgentId)
    .filter((id): id is string => id !== null);

  if (targetAgentIds.length === 0) return [];

  const agents = await db
    .select({
      id: schema.agentsTable.id,
      name: schema.agentsTable.name,
    })
    .from(schema.agentsTable)
    .where(
      and(
        inArray(schema.agentsTable.id, targetAgentIds),
        eq(schema.agentsTable.organizationId, agent.organizationId),
      ),
    );

  const nameMap = new Map(agents.map((a) => [a.id, a.name]));

  return delegationTools.reduce<{ targetAgentName: string }[]>((acc, t) => {
    const targetId = t.delegateToAgentId;
    if (targetId) {
      const name = nameMap.get(targetId);
      if (name) {
        acc.push({ targetAgentName: name });
      }
    }
    return acc;
  }, []);
}

/**
 * Resolve knowledge base IDs to portable references (names).
 */
async function resolveKnowledgeBaseReferences(
  knowledgeBaseIds: string[],
  organizationId?: string,
): Promise<AgentExportPayload["knowledgeBases"]> {
  if (knowledgeBaseIds.length === 0) return [];

  const kbs = await db
    .select({
      id: schema.knowledgeBasesTable.id,
      name: schema.knowledgeBasesTable.name,
    })
    .from(schema.knowledgeBasesTable)
    .where(
      and(
        inArray(schema.knowledgeBasesTable.id, knowledgeBaseIds),
        ...(organizationId
          ? [eq(schema.knowledgeBasesTable.organizationId, organizationId)]
          : []),
      ),
    );

  return kbs.map((kb) => ({ name: kb.name }));
}

/**
 * Resolve connector IDs to portable references (name + type).
 */
async function resolveConnectorReferences(
  connectorIds: string[],
  organizationId?: string,
): Promise<AgentExportPayload["connectors"]> {
  if (connectorIds.length === 0) return [];

  const connectors = await db
    .select({
      id: schema.knowledgeBaseConnectorsTable.id,
      name: schema.knowledgeBaseConnectorsTable.name,
      connectorType: schema.knowledgeBaseConnectorsTable.connectorType,
    })
    .from(schema.knowledgeBaseConnectorsTable)
    .where(
      and(
        inArray(schema.knowledgeBaseConnectorsTable.id, connectorIds),
        ...(organizationId
          ? [
              eq(
                schema.knowledgeBaseConnectorsTable.organizationId,
                organizationId,
              ),
            ]
          : []),
      ),
    );

  return connectors.map((c) => ({
    name: c.name,
    connectorType: c.connectorType,
  }));
}
