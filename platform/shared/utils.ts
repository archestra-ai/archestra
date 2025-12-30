import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "./consts";

export function isArchestraMcpServerTool(toolName: string): boolean {
  return toolName.startsWith(
    `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`,
  );
}

/**
 * Check if a value is a BYOS vault reference (path#key format)
 * Type guard to narrow string | undefined to string
 */
export function isVaultReference(value: string | undefined): value is string {
  if (!value) return false;
  // Vault references look like "secret/data/path/to/secret#keyname"
  // They contain a # and the part before # looks like a path
  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) return false;
  const path = value.substring(0, hashIndex);
  // Basic check: path should contain "/" and not be too short
  return path.includes("/") && path.length > 5;
}

/**
 * Parse a vault reference into path and key
 */
export function parseVaultReference(value: string): {
  path: string;
  key: string;
} {
  const hashIndex = value.indexOf("#");
  return {
    path: value.substring(0, hashIndex),
    key: value.substring(hashIndex + 1),
  };
}

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
