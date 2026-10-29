import type { TargetInstallCaller } from "@/clients/mcp-client";
import { McpServerToolDescriptionModel } from "@/models";
import type { Tool } from "@/types";

/**
 * Per-installation tool descriptions.
 *
 * A catalog item's `tools` rows are shared by all of its installations, but an
 * MCP server may describe its tools differently for each authenticated account
 * (for example, by naming the signed-in user). The shared row keeps whichever
 * installation synced last, so serving it as-is tells every caller what some
 * other account's installation said. Each sync therefore also records what the
 * syncing installation reported, and listing surfaces serve each caller the
 * description from the installation their call would run through.
 */

/**
 * Record what one installation's `tools/list` reported, after its tools were
 * synced into the shared rows. `syncedTools` are the rows the sync returned;
 * `reported` is the list the installation sent.
 */
export async function recordInstallToolDescriptions(params: {
  mcpServerId: string;
  syncedTools: Array<Pick<Tool, "id" | "rawName" | "description">>;
  reported: Array<{ rawToolName?: string; description: string | null }>;
}): Promise<void> {
  const reportedByRawName = new Map(
    params.reported.flatMap((tool) =>
      tool.rawToolName ? [[tool.rawToolName, tool.description] as const] : [],
    ),
  );
  await McpServerToolDescriptionModel.replaceForServer({
    mcpServerId: params.mcpServerId,
    descriptions: params.syncedTools.map((tool) => ({
      toolId: tool.id,
      // A row matched by a concurrent sync may hold another installation's
      // text, so prefer what this installation reported for the tool.
      description:
        tool.rawName !== null && reportedByRawName.has(tool.rawName)
          ? (reportedByRawName.get(tool.rawName) ?? null)
          : tool.description,
    })),
  });
}

/**
 * Give each tool the description reported by the installation its call would
 * run through for this caller. Tools whose installations all agree with the
 * shared row, and tools no installation can serve for this caller, keep the
 * shared description.
 */
export async function describeToolsForCaller<
  T extends Pick<
    Tool,
    "id" | "name" | "catalogId" | "rawName" | "parameters" | "meta"
  > & { description: string | null },
>(params: {
  tools: T[];
  agentId: string;
  tokenAuth?: TargetInstallCaller;
}): Promise<T[]> {
  const { tools, agentId, tokenAuth } = params;
  const divergentToolIds =
    await McpServerToolDescriptionModel.findToolIdsWithDivergentDescriptions(
      tools.flatMap((tool) => (tool.catalogId ? [tool.id] : [])),
    );
  if (divergentToolIds.size === 0) {
    return tools;
  }

  const divergentTools = tools.filter((tool) => divergentToolIds.has(tool.id));
  // Dynamic import: mcp-client reaches the built-in tools that call this.
  const { default: mcpClient } = await import("@/clients/mcp-client");
  const installByToolName = await mcpClient.resolveToolInstallsForCaller({
    agentId,
    tokenAuth,
    tools: divergentTools,
  });
  const pairs = divergentTools.flatMap((tool) => {
    const mcpServerId = installByToolName.get(tool.name);
    return mcpServerId ? [{ mcpServerId, toolId: tool.id }] : [];
  });
  const descriptions = await McpServerToolDescriptionModel.findForPairs(pairs);

  return tools.map((tool) => {
    if (!divergentToolIds.has(tool.id)) return tool;
    const mcpServerId = installByToolName.get(tool.name);
    const forInstall = mcpServerId ? descriptions.get(mcpServerId) : undefined;
    return forInstall?.has(tool.id)
      ? { ...tool, description: forInstall.get(tool.id) ?? null }
      : tool;
  });
}
