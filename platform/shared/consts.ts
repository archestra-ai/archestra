export const E2eTestId = {
  AgentsTable: "agents-table",
  CreateAgentButton: "create-agent-button",
  CreateAgentCloseHowToConnectButton: "create-agent-how-to-connect-button",
  DeleteAgentButton: "delete-agent-button",
  OnboardingNextButton: "onboarding-next-button",
  OnboardingFinishButton: "onboarding-finish-button",
  OnboardingSkipButton: "onboarding-skip-button",
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

export const MCP_CATALOG_API_BASE_URL =
  "https://www.archestra.ai/mcp-catalog/api";
