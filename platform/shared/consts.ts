export const E2eTestId = {
  AgentsTable: "agents-table",
  CreateAgentButton: "create-agent-button",
  CreateAgentCloseHowToConnectButton: "create-agent-how-to-connect-button",
  DeleteAgentButton: "delete-agent-button",
  OnboardingNextButton: "onboarding-next-button",
  OnboardingFinishButton: "onboarding-finish-button",
  OnboardingSkipButton: "onboarding-skip-button",
  InviteMemberButton: "invite-member-button",
  InviteEmailInput: "invite-email-input",
  InviteRoleSelect: "invite-role-select",
  GenerateInvitationButton: "generate-invitation-button",
  InvitationLinkInput: "invitation-link-input",
  InvitationLinkCopyButton: "invitation-link-copy-button",
  InvitationErrorMessage: "invitation-error-message",
  SidebarUserProfile: "sidebar-user-profile",
  LocalInstallationsDialog: "local-installations-dialog",
  LocalInstallationsTable: "local-installations-table",
  CredentialRow: "credential-row",
  CredentialOwnerEmail: "credential-owner-email",
  CredentialTeamSelect: "credential-team-select",
  ManageCredentialsButton: "manage-credentials-button",
  ConfigureSsoTeamSyncButton: "configure-sso-team-sync-button",
  McpServerCard: "mcp-server-card",
} as const;
export type E2eTestId = (typeof E2eTestId)[keyof typeof E2eTestId];

export const DEFAULT_ADMIN_EMAIL = "admin@example.com";
export const DEFAULT_ADMIN_PASSWORD = "password";

export const DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME = "ARCHESTRA_AUTH_ADMIN_EMAIL";
export const DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME =
  "ARCHESTRA_AUTH_ADMIN_PASSWORD";

export const EMAIL_PLACEHOLDER = "admin@example.com";
export const PASSWORD_PLACEHOLDER = "password";

export const DEFAULT_PROFILE_NAME = "Default Profile with Archestra";

/**
 * Separator used to construct fully-qualified MCP tool names
 * Format: {mcpServerName}__{toolName}
 */
export const MCP_SERVER_TOOL_NAME_SEPARATOR = "__";
export const ARCHESTRA_MCP_SERVER_NAME = "archestra";

/**
 * Special tools which have handlers on the frontend...
 */
export const TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request`;

export const MCP_CATALOG_API_BASE_URL = "https://archestra.ai/mcp-catalog/api";

/**
 * SSO Provider IDs - these are the canonical provider identifiers used for:
 * - Account linking (trustedProviders)
 * - Provider registration
 * - Callback URLs (e.g., /api/auth/sso/callback/{providerId})
 */
export const SSO_PROVIDER_ID = {
  OKTA: "Okta",
  GOOGLE: "Google",
  GITHUB: "GitHub",
  GITLAB: "GitLab",
  ENTRA_ID: "EntraID",
} as const;

export type SsoProviderId =
  (typeof SSO_PROVIDER_ID)[keyof typeof SSO_PROVIDER_ID];

/** List of all predefined SSO provider IDs for account linking */
export const SSO_TRUSTED_PROVIDER_IDS = Object.values(SSO_PROVIDER_ID);
