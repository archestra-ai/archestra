import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "./consts";

export function formatSecretStorageType(
  storageType: "vault" | "external_vault" | "database" | "none" | undefined,
): string {
  switch (storageType) {
    case "vault":
      return "Vault";
    case "external_vault":
      return "External Vault";
    case "database":
      return "Database";
    default:
      return "None";
  }
}

/**
 * Slugify a name to create a URL-safe identifier
 * Used for generating tool names from prompt/agent names
 */
export function slugify(name: string): string {
  const slugified = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  // Trim leading and trailing underscores without backtracking regex
  let start = 0;
  let end = slugified.length;
  while (start < end && slugified[start] === "_") start++;
  while (end > start && slugified[end - 1] === "_") end--;

  return slugified.slice(start, end);
}

/**
 * Parse a fully-qualified MCP tool name into server name and raw tool name.
 * Splits on the last separator so server names can themselves contain "__".
 */
export function parseFullToolName(fullName: string): {
  serverName: string | null;
  toolName: string;
} {
  const index = fullName.lastIndexOf(MCP_SERVER_TOOL_NAME_SEPARATOR);
  if (index <= 0) {
    return { serverName: null, toolName: fullName };
  }

  return {
    serverName: fullName.substring(0, index),
    toolName: fullName.substring(index + MCP_SERVER_TOOL_NAME_SEPARATOR.length),
  };
}

export function buildFullToolName(
  serverName: string,
  toolName: string,
): string {
  return `${serverName}__${toolName}`;
}
