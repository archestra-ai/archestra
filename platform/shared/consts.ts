export const E2eTestId = {
  AgentsTable: "agents-table",
  CreateAgentButton: "create-agent-button",
  CreateAgentCloseHowToConnectButton: "create-agent-how-to-connect-button",
  DeleteAgentButton: "delete-agent-button",
} as const;
export type E2eTestId = (typeof E2eTestId)[keyof typeof E2eTestId];

export const DEFAULT_ADMIN_EMAIL = "admin@example.com";
export const DEFAULT_ADMIN_PASSWORD = "password";

export const DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME = "ARCHESTRA_AUTH_ADMIN_EMAIL";
export const DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME =
  "ARCHESTRA_AUTH_ADMIN_PASSWORD";

export const EMAIL_PLACEHOLDER = "admin@example.com";
export const PASSWORD_PLACEHOLDER = "password";

export const DEFAULT_AGENT_NAME = "Default Agent with Archestra";

/**
 * Separator used to construct fully-qualified MCP tool names
 * Format: {mcpServerName}__{toolName}
 */
export const MCP_SERVER_TOOL_NAME_SEPARATOR = "__";

/**
 * NOTE: THIS IS ABSOLUTELY TEMPORARY.. remove this once we have full/generic support for MCP servers.
 */
export const GITHUB_MCP_SERVER_NAME = "githubcopilot__remote-mcp";
