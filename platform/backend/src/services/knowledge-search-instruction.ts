import {
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { isArchestraToolAvailableToAgent } from "@/archestra-mcp-server/dynamic-tools";
import { filterToolNamesByPermission } from "@/archestra-mcp-server/rbac";
import type { RequestLookups } from "@/auth/request-lookups";
import { buildKnowledgeSourcesDescription } from "./knowledge-sources-description";

/** Shared guidance for chat/A2A prompts and external clients' tool discovery. */
export async function buildKnowledgeSearchInstruction(params: {
  agentId: string;
  userId?: string;
  organizationId?: string;
  /** Names on the caller's already permission-filtered, advertised surface. */
  toolNames: string[];
  lookups?: RequestLookups;
}): Promise<string | null> {
  const knowledgeTool = archestraMcpBranding.getToolName(
    TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
  );
  const searchTool = archestraMcpBranding.getToolName(
    TOOL_SEARCH_TOOLS_SHORT_NAME,
  );
  const runTool = archestraMcpBranding.getToolName(TOOL_RUN_TOOL_SHORT_NAME);
  const directlyAvailable = params.toolNames.includes(knowledgeTool);
  if (!directlyAvailable) {
    if (
      !params.toolNames.includes(searchTool) ||
      !params.toolNames.includes(runTool)
    ) {
      return null;
    }
    const permitted = await filterToolNamesByPermission(
      [knowledgeTool],
      params.userId,
      params.organizationId,
      params.lookups,
    );
    if (
      !permitted.has(knowledgeTool) ||
      !(await isArchestraToolAvailableToAgent({
        toolName: knowledgeTool,
        agentId: params.agentId,
        userId: params.userId,
        organizationId: params.organizationId,
        lookups: params.lookups,
      }))
    ) {
      return null;
    }
  }

  const description = await buildKnowledgeSourcesDescription(
    params.agentId,
    params.organizationId
      ? { userId: params.userId, organizationId: params.organizationId }
      : undefined,
    params.lookups,
  );
  if (!description) return null;
  const instruction = `Internal knowledge search is available. ${description}`;
  return directlyAvailable
    ? `${instruction} Use \`${knowledgeTool}\` with the user's original query.`
    : `${instruction} Discover \`${knowledgeTool}\` with \`${searchTool}\`, then call it through \`${runTool}\` with the user's original query.`;
}
