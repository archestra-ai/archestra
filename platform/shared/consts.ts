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
  ManageCredentialsDialog: "manage-credentials-dialog",
  ManageCredentialsDialogTable: "manage-credentials-dialog-table",
  CredentialRow: "credential-row",
  CredentialOwner: "credential-owner",
  CredentialTeamSelect: "credential-team-select",
  ManageCredentialsButton: "manage-credentials-button",
  ManageToolsButton: "manage-tools-button",
  ConfigureSsoTeamSyncButton: "configure-sso-team-sync-button",
  SsoRoleMappingDefaultRole: "sso-role-mapping-default-role",
  SsoRoleMappingRuleRole: "sso-role-mapping-rule-role",
  SsoRoleMappingRuleTemplate: "sso-role-mapping-rule-template",
  SsoRoleMappingAddRule: "sso-role-mapping-add-rule",
  McpServerCard: "mcp-server-card",
  McpToolsDialog: "mcp-tools-dialog",
  TokenSelect: "token-select",
  ProfileTokenManagerTeamsSelect: "profile-token-manager-teams-select",
  ConnectAgentButton: "connect-agent-button",
  ConnectCatalogItemButton: "connect-catalog-item-button",
  SelectCredentialTypePersonal: "select-credential-type-personal",
  SelectCredentialTypeTeam: "select-credential-type-team",
  CredentialsCount: "credentials-count",
  StaticCredentialToUse: "static-credential-to-use",
  SelectCredentialTypeTeamDropdown: "select-credential-type-team-dropdown",
  ProfileTeamBadge: "profile-team-badge",
  EditAgentButton: "edit-agent-button",
  RemoveTeamBadge: "remove-team-badge",
  PromptOnInstallationCheckbox: "prompt-on-installation-checkbox",
  RevokeCredentialButton: "revoke-credential-button",
  ExternalSecretSelector: "external-secret-selector",
  SelectEnvironmentVariableType: "select-environment-variable-type",
  AddCatalogItemButton: "add-catalog-item-button",
  ConfigureVaultFolderButton: "configure-vault-folder-button",
  ExternalSecretSelectorTeamTrigger: "external-secret-selector-team-trigger",
  ExternalSecretSelectorSecretTrigger:
    "external-secret-selector-secret-trigger",
  ExternalSecretSelectorSecretTriggerKey:
    "external-secret-selector-secret-trigger-key",
  InlineVaultSecretSelectorSecretTrigger:
    "inline-vault-secret-selector-secret-trigger",
  InlineVaultSecretSelectorSecretTriggerKey:
    "inline-vault-secret-selector-secret-trigger-key",
  ManageMembersButton: "manage-members-button",
  // Chat Settings
  ChatApiKeysTable: "chat-api-keys-table",
  AddChatApiKeyButton: "add-chat-api-key-button",
  ChatApiKeyRow: "chat-api-key-row",
  EditChatApiKeyButton: "edit-chat-api-key-button",
  DeleteChatApiKeyButton: "delete-chat-api-key-button",
  SetDefaultChatApiKeyButton: "set-default-chat-api-key-button",
  ManageProfilesChatApiKeyButton: "manage-profiles-chat-api-key-button",
  ChatApiKeyDefaultBadge: "chat-api-key-default-badge",
  BulkAssignChatApiKeysButton: "bulk-assign-chat-api-keys-button",
  BulkAssignChatApiKeysDialog: "bulk-assign-chat-api-keys-dialog",
} as const;
export type E2eTestId = (typeof E2eTestId)[keyof typeof E2eTestId];

export const DEFAULT_ADMIN_EMAIL = "admin@example.com";
export const DEFAULT_ADMIN_PASSWORD = "password";

export const DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME = "ARCHESTRA_AUTH_ADMIN_EMAIL";
export const DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME =
  "ARCHESTRA_AUTH_ADMIN_PASSWORD";

export const EMAIL_PLACEHOLDER = "admin@example.com";
export const PASSWORD_PLACEHOLDER = "password";

export const DEFAULT_PROFILE_NAME = "Default Profile";

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

export const MCP_CATALOG_API_BASE_URL =
  process.env.ARCHESTRA_MCP_CATALOG_API_BASE_URL ||
  "https://archestra.ai/mcp-catalog/api";

/**
 * Header name for external agent ID.
 * Clients can pass this header to associate interactions with their own agent identifiers.
 */
export const EXTERNAL_AGENT_ID_HEADER = "X-Archestra-Agent-Id";

/**
 * Header name for user ID.
 * Clients can pass this header to associate interactions with a specific user (by their Archestra user UUID).
 * Particularly useful for identifying which user was using the Archestra Chat.
 */
export const USER_ID_HEADER = "X-Archestra-User-Id";

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

export const DEFAULT_VAULT_TOKEN = "dev-root-token";
