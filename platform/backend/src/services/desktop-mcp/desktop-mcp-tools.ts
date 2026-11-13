import type McpServerModel from "@/models/mcp-server";
import ToolModel from "@/models/tool";
import { recordInstallToolDescriptions } from "@/services/mcp-install-tool-descriptions";
import type { InternalMcpCatalog, Tool } from "@/types";

type ReportedByServer = Awaited<
  ReturnType<typeof McpServerModel.getToolsFromServer>
>;

/** A tool as one computer's MCP server reported it, named for its catalog item. */
type ReportedTool = Parameters<
  typeof ToolModel.bulkCreateToolsIfNotExists
>[0][number] & { rawToolName: string };

/**
 * Puts the tool list that one computer's MCP server reported into the tools
 * of its desktop MCP catalog item.
 *
 * All installations of a catalog item share its tools, and each runs on a
 * different computer, perhaps with a different version of the server. So one
 * computer only adds the tools that are missing: it does not change a stored
 * tool and does not delete one, or a user with an older version would take a
 * tool away from every other user and from the agents it is assigned to.
 */
export async function syncDesktopMcpTools(params: {
  /** The installation whose server reported the tools. */
  mcpServerId: string;
  catalogItem: Pick<InternalMcpCatalog, "id" | "name">;
  tools: ReportedByServer;
}): Promise<{ created: Tool[]; unchanged: Tool[] }> {
  const { catalogItem, tools } = params;
  const reported: ReportedTool[] = tools.map((tool) => ({
    name: ToolModel.slugifyName(catalogItem.name, tool.name),
    rawToolName: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    meta: {
      _meta: tool._meta,
      annotations: tool.annotations,
      outputSchema: tool.outputSchema,
    },
    catalogId: catalogItem.id,
  }));
  const reportedNames = new Set(reported.map((tool) => tool.name));

  const stored = (
    await ToolModel.findByCatalogId(catalogItem.id, {
      kind: "internal",
      purpose: "install",
    })
  ).filter((tool) => reportedNames.has(tool.name));
  const storedNames = new Set(stored.map((tool) => tool.name));
  const created = await ToolModel.bulkCreateToolsIfNotExists(
    reported.filter((tool) => !storedNames.has(tool.name)),
  );
  // A cloned catalog item starts with the tools of its source, hidden until a
  // server confirms them: keep the ones this server reports and drop the
  // rest, as an install of each other server type does.
  if ((await ToolModel.countProvisionalForCatalog(catalogItem.id)) > 0) {
    await ToolModel.reconcileClonedCatalogTools({
      catalogId: catalogItem.id,
      discoveredToolNames: reportedNames,
    });
  }
  const unchanged = await ToolModel.getByIds(stored.map((tool) => tool.id));
  // Each installation keeps the descriptions its own server reported.
  await recordInstallToolDescriptions({
    mcpServerId: params.mcpServerId,
    syncedTools: [...created, ...unchanged],
    reported,
  });
  return { created, unchanged };
}
