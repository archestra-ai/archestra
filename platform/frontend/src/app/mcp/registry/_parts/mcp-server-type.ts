import type { archestraApiTypes } from "@archestra/shared";
import type { McpServerCardVariant } from "./mcp-server-card";

export type CatalogServerType =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number]["serverType"];

/**
 * Which of its faces the registry shows a catalog item with. The card, the
 * table and the server page branch on this instead of each deciding what "not
 * built-in and not remote" means: that default is self-hosted, and a desktop
 * MCP server (no pod, no URL) must never land in it.
 */
export function mcpServerVariant(
  serverType: CatalogServerType,
): McpServerCardVariant {
  if (serverType === "builtin") return "builtin";
  if (serverType === "remote") return "remote";
  if (serverType === "desktop_mcp") return "desktop";
  return "local";
}

/** The server type in the words the registry uses for it. */
export function mcpServerTypeLabel(serverType: CatalogServerType): string {
  return SERVER_TYPE_LABEL[serverType];
}

/**
 * A server people install, as opposed to one they connect an account to. The
 * registry words the two differently: "Installations" and "Uninstall" for the
 * first, "Credentials" and "Revoke" for the second.
 */
export function usesInstallations(
  serverType: CatalogServerType | undefined,
): boolean {
  return serverType === "local" || serverType === "desktop_mcp";
}

/**
 * Whether the server has an environment to name. A built-in server is not
 * environment-scoped, and a desktop MCP server runs on its user's computer.
 */
export function runsInEnvironment(serverType: CatalogServerType): boolean {
  return serverType !== "builtin" && serverType !== "desktop_mcp";
}

// ===

const SERVER_TYPE_LABEL: Record<CatalogServerType, string> = {
  remote: "Remote",
  local: "Self-hosted",
  builtin: "Built-in",
  app: "App",
  desktop_mcp: "Desktop MCP",
};
