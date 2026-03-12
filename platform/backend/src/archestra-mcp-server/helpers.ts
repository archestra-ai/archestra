import logger from "@/logging";
import { AgentModel, AgentToolModel, ToolModel } from "@/models";

/**
 * Convert a name to a URL-safe slug for tool naming
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  return error.message.toLowerCase().includes("abort");
}

export type McpServerResult = {
  id: string;
  status: string;
  toolCount?: number;
};
export type SubAgentResult = { id: string; status: string };

export async function assignMcpServerTools(
  agentId: string,
  mcpServerIds: string[],
): Promise<McpServerResult[]> {
  const results: McpServerResult[] = [];
  for (const mcpServerId of mcpServerIds) {
    try {
      const tools = await ToolModel.findByCatalogId(mcpServerId);
      if (tools.length === 0) {
        results.push({ id: mcpServerId, status: "no_tools" });
        continue;
      }
      await AgentToolModel.createManyIfNotExists(
        agentId,
        tools.map((t) => t.id),
      );
      results.push({
        id: mcpServerId,
        status: "success",
        toolCount: tools.length,
      });
    } catch (error) {
      logger.error(
        { err: error, mcpServerId },
        "Error assigning MCP server tools",
      );
      results.push({ id: mcpServerId, status: "error" });
    }
  }
  return results;
}

export async function assignSubAgentDelegations(
  agentId: string,
  subAgentIds: string[],
): Promise<SubAgentResult[]> {
  const results: SubAgentResult[] = [];
  for (const subAgentId of subAgentIds) {
    try {
      const exists = await AgentModel.exists(subAgentId);
      if (!exists) {
        results.push({ id: subAgentId, status: "not_found" });
        continue;
      }
      await AgentToolModel.assignDelegation(agentId, subAgentId);
      results.push({ id: subAgentId, status: "success" });
    } catch (error) {
      logger.error(
        { err: error, subAgentId },
        "Error assigning sub-agent delegation",
      );
      results.push({ id: subAgentId, status: "error" });
    }
  }
  return results;
}

export function formatAssignmentSummary(
  lines: string[],
  mcpServerResults: McpServerResult[],
  subAgentResults: SubAgentResult[],
): void {
  if (mcpServerResults.length > 0) {
    lines.push(
      "",
      "MCP Server Tool Assignments:",
      ...mcpServerResults.map(
        (r) =>
          `  - ${r.id}: ${r.status}${r.toolCount ? ` (${r.toolCount} tools)` : ""}`,
      ),
    );
  }
  if (subAgentResults.length > 0) {
    lines.push(
      "",
      "Sub-Agent Delegations:",
      ...subAgentResults.map((r) => `  - ${r.id}: ${r.status}`),
    );
  }
}

export function deduplicateLabels(
  rawLabels: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  return Array.from(new Map(rawLabels.map((l) => [l.key, l])).values());
}
