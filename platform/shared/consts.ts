import { z } from "zod";
import type { SupportedProvider } from "./model-constants";

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
  McpServerError: "mcp-server-error",
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
  ChatApiKeyForm: "chat-api-key-form",
  EditChatApiKeyButton: "edit-chat-api-key-button",
  DeleteChatApiKeyButton: "delete-chat-api-key-button",
  SetDefaultChatApiKeyButton: "set-default-chat-api-key-button",
  ManageProfilesChatApiKeyButton: "manage-profiles-chat-api-key-button",
  ChatApiKeyDefaultBadge: "chat-api-key-default-badge",
  BulkAssignChatApiKeysButton: "bulk-assign-chat-api-keys-button",
  BulkAssignChatApiKeysDialog: "bulk-assign-chat-api-keys-dialog",
  // Chat Prompt Input
  ChatFileUploadButton: "chat-file-upload-button",
  ChatDisabledFileUploadButton: "chat-disabled-file-upload-button",
  // Chat Model Selector
  ChatModelSelectorTrigger: "chat-model-selector-trigger",
  ChatPromptTextarea: "chat-prompt-textarea",
  // MCP Logs
  McpLogsDialog: "mcp-logs-dialog",
  McpLogsContent: "mcp-logs-content",
  McpLogsError: "mcp-logs-error",
  McpLogsViewButton: "mcp-logs-view-button",
  McpLogsEditConfigButton: "mcp-logs-edit-config-button",
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
export const DEFAULT_MCP_GATEWAY_NAME = "Default MCP Gateway";
export const DEFAULT_LLM_PROXY_NAME = "Default LLM Proxy";

/**
 * Separator used to construct fully-qualified MCP tool names
 * Format: {mcpServerName}__{toolName}
 */
export const MCP_SERVER_TOOL_NAME_SEPARATOR = "__";
export const ARCHESTRA_MCP_SERVER_NAME = "archestra";

/**
 * Fixed UUID for the Archestra MCP catalog entry.
 * This ID is constant to ensure consistent catalog lookup across server restarts.
 * Must be a valid UUID format (version 4, variant 8/9/a/b) for Zod validation.
 */
export const ARCHESTRA_MCP_CATALOG_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Prefix for agent delegation tools
 * Format: agent__{slugified_agent_name}
 * These are NOT archestra tools - they are dynamically generated per prompt
 */
export const AGENT_TOOL_PREFIX = `agent${MCP_SERVER_TOOL_NAME_SEPARATOR}`;

/**
 * Special tools which have handlers on the frontend...
 */
export const TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server_installation_request`;
export const TOOL_ARTIFACT_WRITE_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}artifact_write`;
export const TOOL_TODO_WRITE_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`;
export const TOOL_QUERY_KNOWLEDGE_GRAPH_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}query_knowledge_graph`;

export const DEFAULT_ARCHESTRA_TOOL_NAMES = [
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_GRAPH_FULL_NAME,
];

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
 * Header name for session ID.
 * Clients can pass this header to group related LLM requests into a session.
 * This enables session-based grouping in the LLM proxy logs UI.
 */
export const SESSION_ID_HEADER = "X-Archestra-Session-Id";

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

export const TimeInMs = {
  Second: 1_000,
  Minute: 1_000 * 60,
  Hour: 1_000 * 60 * 60,
  Day: 1_000 * 60 * 60 * 24,
} as const;

/**
 * Incoming email security modes.
 * - private: Requires sender email to match an Archestra user who has access to the agent
 * - internal: Only allows emails from a specific domain
 * - public: No sender restrictions (anyone can email the agent)
 */
export const IncomingEmailSecurityModeSchema = z.enum([
  "private",
  "internal",
  "public",
]);
export type IncomingEmailSecurityMode = z.infer<
  typeof IncomingEmailSecurityModeSchema
>;
export const IncomingEmailSecurityModes = Object.values(
  IncomingEmailSecurityModeSchema.enum,
);

/**
 * Constant object for incoming email security mode values.
 * Use this for type-safe comparisons and UI selects.
 */
export const INCOMING_EMAIL_SECURITY_MODE = {
  PRIVATE: "private",
  INTERNAL: "internal",
  PUBLIC: "public",
} as const satisfies Record<string, IncomingEmailSecurityMode>;

/**
 * Check if a value is a valid incoming email security mode
 */
export function isValidIncomingEmailSecurityMode(
  value: string,
): value is IncomingEmailSecurityMode {
  return IncomingEmailSecurityModes.includes(
    value as IncomingEmailSecurityMode,
  );
}

/**
 * Regex pattern for validating domain format.
 * Matches domains like: company.com, sub.company.com, my-company.co.uk
 * Does not match: spaces, special characters (except hyphen), domains starting/ending with hyphen
 */
export const DOMAIN_VALIDATION_REGEX =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;

/**
 * Maximum domain length per DNS specification (RFC 1035).
 */
export const MAX_DOMAIN_LENGTH = 253;

// =============================================================================
// Browser Preview Feature
// =============================================================================

/**
 * Fixed UUID for the Playwright browser preview MCP catalog entry.
 * This ID is constant to ensure consistent catalog lookup across server restarts.
 * Must be a valid UUID format (version 4, variant 8/9/a/b) for Zod validation.
 */
export const PLAYWRIGHT_MCP_CATALOG_ID = "00000000-0000-4000-8000-000000000002";
export const PLAYWRIGHT_MCP_SERVER_NAME = "playwright-browser";

/**
 * Default browser viewport dimensions used by Playwright MCP in browser preview feature.
 */
export const DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH = 800;
export const DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT = 800;

/**
 * Approximate height of the browser preview header (title bar + URL bar).
 * Used when calculating popup window dimensions.
 */
export const BROWSER_PREVIEW_HEADER_HEIGHT = 77;

/**
 * Default URL to show when browser preview is opened for a new conversation.
 * Using about:blank ensures no automatic navigation happens until user requests it.
 */
export const DEFAULT_BROWSER_PREVIEW_URL = "about:blank";

// =============================================================================
// OAuth 2.1 Authorization Server
// =============================================================================

/**
 * Scopes supported by the OAuth 2.1 authorization server.
 * Used by better-auth oauthProvider config, well-known endpoints, and consent UI.
 */
export const OAUTH_SCOPES = [
  "mcp",
  "openid",
  "profile",
  "email",
  "offline_access",
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/**
 * Human-readable descriptions for each OAuth scope.
 * Used by the consent page to explain what each scope grants.
 */
export const OAUTH_SCOPE_DESCRIPTIONS: Record<OAuthScope, string> = {
  mcp: "Access MCP tools and resources",
  openid: "Verify your identity",
  profile: "Access your profile information",
  email: "Access your email address",
  offline_access: "Maintain access when you're not present",
};

/**
 * OAuth 2.1 endpoint paths (relative to base URL).
 * These are served by better-auth and proxied through the frontend catch-all.
 */
export const OAUTH_ENDPOINTS = {
  authorize: "/api/auth/oauth2/authorize",
  token: "/api/auth/oauth2/token",
  register: "/api/auth/oauth2/register",
  jwks: "/api/auth/jwks",
  consent: "/api/auth/oauth2/consent",
} as const;

/**
 * OAuth 2.1 page paths (frontend routes).
 */
export const OAUTH_PAGES = {
  login: "/auth/sign-in",
  consent: "/oauth/consent",
} as const;

/**
 * Prefix for OAuth-derived token IDs in TokenAuthResult.
 * Used when constructing tokenId from OAuth access tokens (e.g. `oauth-${accessToken.id}`)
 * and when detecting OAuth auth method from tokenId.
 */
export const OAUTH_TOKEN_ID_PREFIX = "oauth-";

/**
 * Path for deep-linking to MCP catalog install dialogs.
 * Used by backend error messages and frontend routing.
 * Append `?install={catalogId}` to auto-open the install dialog.
 */
export const MCP_CATALOG_INSTALL_PATH = "/mcp-catalog/registry";
export const MCP_CATALOG_INSTALL_QUERY_PARAM = "install";

/**
 * Providers where an API key is optional (self-hosted providers that typically don't require auth).
 */
export const PROVIDERS_WITH_OPTIONAL_API_KEY = new Set<SupportedProvider>([
  "ollama",
  "vllm",
]);
