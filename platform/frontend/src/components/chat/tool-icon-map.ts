import { parseFullToolName } from "@archestra/shared";

export type ToolIconInfo = { icon?: string | null; catalogId?: string };

/** Resolves a tool name to the icon of the MCP catalog item that serves it. */
export type ToolIconMap = {
  get(toolName: string): ToolIconInfo | undefined;
};

/**
 * Builds the tool name → catalog icon lookup for chat tool circles.
 *
 * Tools assigned to the agent resolve by name. A tool the agent reaches without
 * an assignment (through `run_tool`) resolves by its `<server>__` prefix, which
 * the backend derives from the catalog name.
 */
export function buildToolIconMap(params: {
  agentTools: { name: string; catalogId?: string | null }[];
  catalogItems: { id: string; name: string; icon?: string | null }[];
}): ToolIconMap {
  const catalogById = new Map(params.catalogItems.map((c) => [c.id, c]));
  const byToolName = new Map<string, ToolIconInfo>();
  for (const tool of params.agentTools) {
    const catalog = tool.catalogId ? catalogById.get(tool.catalogId) : null;
    if (catalog) {
      byToolName.set(tool.name, { icon: catalog.icon, catalogId: catalog.id });
    }
  }
  const byServerSlug = new Map<string, ToolIconInfo>();
  for (const catalog of params.catalogItems) {
    byServerSlug.set(serverSlug(catalog.name), {
      icon: catalog.icon,
      catalogId: catalog.id,
    });
  }

  return {
    get(toolName) {
      const assigned = byToolName.get(toolName);
      if (assigned) return assigned;
      const { serverName } = parseFullToolName(toolName);
      return serverName ? byServerSlug.get(serverName) : undefined;
    },
  };
}

// Mirrors `ToolModel.sanitizeServerNameForSlug` in the backend.
function serverSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "");
}
