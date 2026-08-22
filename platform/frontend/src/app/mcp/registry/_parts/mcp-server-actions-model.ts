import { MCP_CATALOG_CLONE_QUERY_PARAM } from "@archestra/shared";

export type McpServerActionId =
  | "connections"
  | "usage"
  | "logs"
  | "edit"
  | "clone"
  | "delete";

export interface McpServerActionDefinition {
  id: McpServerActionId;
  label: string;
  href?: string;
}

/**
 * Canonical navigation actions shared by registry rows and server headers.
 * Connection-level mutations remain in the Connections section, but every
 * route-level action gets its label and destination here.
 */
export function getMcpServerActionModel(item: {
  id: string;
  serverType: "app" | "builtin" | "local" | "remote";
}): McpServerActionDefinition[] {
  const pathname = `/mcp/registry/${item.id}`;
  return [
    {
      id: "connections",
      label:
        item.serverType === "local" || item.serverType === "app"
          ? "Installations"
          : "Credentials",
      href:
        item.serverType === "builtin"
          ? undefined
          : `${pathname}?tab=credentials`,
    },
    {
      id: "usage",
      label: "Usage",
      href: `${pathname}?tab=usage`,
    },
    {
      id: "logs",
      label: "View logs",
      href: `${pathname}?tab=logs`,
    },
    {
      id: "edit",
      label: "Edit",
      href: `${pathname}/edit?step=configuration`,
    },
    {
      id: "clone",
      label: "Clone",
      href: `/mcp/registry/new?${MCP_CATALOG_CLONE_QUERY_PARAM}=${item.id}`,
    },
    {
      id: "delete",
      label: "Delete",
    },
  ];
}

export function mcpServerAction(
  model: McpServerActionDefinition[],
  id: McpServerActionId,
) {
  const definition = model.find((candidate) => candidate.id === id);
  if (!definition)
    throw new Error(`Missing MCP server action definition: ${id}`);
  return definition;
}

export function mcpServerActionHref(
  definition: McpServerActionDefinition,
): string {
  if (!definition.href) {
    throw new Error(`MCP server action has no destination: ${definition.id}`);
  }
  return definition.href;
}
