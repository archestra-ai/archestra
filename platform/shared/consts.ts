/** Default app name used as fallback when organization.appName is not configured */
export const DEFAULT_APP_NAME = "Archestra";
export const DEFAULT_APP_FULL_NAME = "Archestra.AI";
export const DEFAULT_APP_DESCRIPTION =
  "Enterprise MCP-native Secure AI Platform";

/**
 * Prefix used for newly generated platform-managed tokens (team tokens, user
 * tokens, virtual API keys, API keys). Keep this branding-neutral.
 */
export const ARCHESTRA_TOKEN_PREFIX = "arch_";

/**
 * Legacy token prefixes that must remain valid for backwards compatibility.
 */
export const LEGACY_ARCHESTRA_TOKEN_PREFIXES = ["archestra_"] as const;

/**
 * All accepted platform-managed token prefixes, ordered from current to legacy.
 */
export const ALL_ARCHESTRA_TOKEN_PREFIXES = [
  ARCHESTRA_TOKEN_PREFIX,
  ...LEGACY_ARCHESTRA_TOKEN_PREFIXES,
] as const;

export const DEFAULT_ADMIN_EMAIL = "admin@example.com";
export const DEFAULT_ADMIN_PASSWORD = "password";

export const DEFAULT_ADMIN_EMAIL_ENV_VAR_NAME = "ARCHESTRA_AUTH_ADMIN_EMAIL";
export const DEFAULT_ADMIN_PASSWORD_ENV_VAR_NAME =
  "ARCHESTRA_AUTH_ADMIN_PASSWORD";

export const EMAIL_PLACEHOLDER = "admin@example.com";
export const PASSWORD_PLACEHOLDER = "password";

export const DEFAULT_LLM_PROXY_NAME = "Default LLM Proxy";
/** @deprecated Default Team is no longer auto-created/auto-assigned. Kept for backward compat with E2E tests. */
export const DEFAULT_TEAM_NAME = "Default Team";

export const MCP_OAUTH_ACCESS_TOKEN_MIN_LIFETIME_SECONDS = 300;
export const MCP_OAUTH_ACCESS_TOKEN_MAX_LIFETIME_SECONDS = 31_536_000;
export const DEFAULT_MCP_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS = 31_536_000;

/**
 * Separator used to construct fully-qualified MCP tool names
 * Format: {mcpServerName}__{toolName}
 */
export const MCP_SERVER_TOOL_NAME_SEPARATOR = "__";

export const WEBSITE_URL = "https://archestra.ai";
export const GITHUB_REPO_URL = "https://github.com/archestra-ai/archestra";
export const GITHUB_REPO_NEW_ISSUE_URL = `${GITHUB_REPO_URL}/issues/new`;
export const COMMUNITY_SLACK_URL = `${WEBSITE_URL}/join-slack`;

export const MCP_CATALOG_API_BASE_URL =
  process.env.ARCHESTRA_MCP_CATALOG_API_BASE_URL ||
  `${WEBSITE_URL}/mcp-catalog/api`;

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
 * Header name for interaction source.
 * Indicates where the request originated from (e.g., "chat", "chatops:slack", "email").
 * Internal-only header — external API requests default to "api".
 */
export const SOURCE_HEADER = "X-Archestra-Source";

/**
 * Header used by internal delegated agent calls to indicate that the parent
 * execution context was already untrusted/sensitive.
 */
export const UNTRUSTED_CONTEXT_HEADER = "X-Archestra-Context-Untrusted";

/**
 * Header name for execution ID.
 * Clients can pass this header to associate interactions with a specific execution run.
 */
export const EXECUTION_ID_HEADER = "X-Archestra-Execution-Id";

/**
 * Composite meta header with format: external-agent-id/execution-id/session-id.
 * Provides a convenience way to set all three values at once.
 * Individual headers take precedence over meta header values.
 * Any segment can be empty (e.g., "/exec-123/" sets only execution-id).
 *
 * Values must not contain "/" since it is used as the segment delimiter.
 */
export const META_HEADER = "X-Archestra-Meta";

/**
 * Header used to pass a per-key provider base URL from chat → LLM proxy.
 * When present, the proxy uses this value instead of the env-var-based config default.
 */
export const PROVIDER_BASE_URL_HEADER = "X-Archestra-Provider-Base-Url";

/**
 * Header used to pass the chat_api_keys row ID from chat → LLM proxy so the
 * proxy can look up per-key configuration (currently `extraHeaders`) for
 * raw-bearer calls that originate from the in-app chat. Only honored on
 * loopback requests, like PROVIDER_BASE_URL_HEADER, to prevent external
 * clients from spoofing arbitrary key IDs.
 */
export const CHAT_API_KEY_ID_HEADER = "X-Archestra-Chat-Api-Key-Id";

export const DEFAULT_VAULT_TOKEN = "dev-root-token";

export const TimeInMs = {
  Second: 1_000,
  Minute: 1_000 * 60,
  Hour: 1_000 * 60 * 60,
  Day: 1_000 * 60 * 60 * 24,
} as const;

export const AUTO_PROVISIONED_INVITATION_STATUS = "auto-provisioned";

export function getArchestraTokenPrefix(value: string): string | null {
  return (
    ALL_ARCHESTRA_TOKEN_PREFIXES.find((prefix) => value.startsWith(prefix)) ??
    null
  );
}

export function hasArchestraTokenPrefix(value: string): boolean {
  return getArchestraTokenPrefix(value) !== null;
}
