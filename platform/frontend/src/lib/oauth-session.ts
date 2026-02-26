/**
 * OAuth session storage helpers.
 *
 * Centralizes all sessionStorage keys used during the OAuth flow so they
 * aren't duplicated as string literals across InternalMCPCatalog,
 * manage-users-dialog, and the oauth-callback page.
 *
 * Security note: Some values stored here (e.g. environment variables) may
 * contain sensitive data. sessionStorage is scoped to the browser tab and
 * cleared on tab close, and the OAuth redirect flow requires state to survive
 * a full-page navigation. All stored values are cleaned up promptly via
 * clearInstallContext() after the callback completes.
 */

// ─── Key constants ───────────────────────────────────────────────────
const OAUTH_STATE = "oauth_state";
const OAUTH_CATALOG_ID = "oauth_catalog_id";
const OAUTH_TEAM_ID = "oauth_team_id";
const OAUTH_IS_FIRST_INSTALLATION = "oauth_is_first_installation";
const OAUTH_MCP_SERVER_ID = "oauth_mcp_server_id";
const OAUTH_INSTALLATION_COMPLETE_CATALOG_ID =
  "oauth_installation_complete_catalog_id";
const OAUTH_SERVER_TYPE = "oauth_server_type";
const OAUTH_ENVIRONMENT_VALUES = "oauth_environment_values";
const OAUTH_PENDING_AFTER_ENV_VARS = "oauth_pending_after_env_vars";

// Dynamic key prefix (combined with code + state to deduplicate callbacks)
const OAUTH_PROCESSING_PREFIX = "oauth_processing_";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Store the OAuth PKCE state value so the callback can verify it. */
export function setOAuthState(state: string) {
  sessionStorage.setItem(OAUTH_STATE, state);
}

/** Store the catalog ID that initiated the OAuth flow. */
export function setOAuthCatalogId(catalogId: string) {
  sessionStorage.setItem(OAUTH_CATALOG_ID, catalogId);
}

/** Store the team ID to associate with the installed server after OAuth. */
export function setOAuthTeamId(teamId: string | null) {
  if (teamId) {
    sessionStorage.setItem(OAUTH_TEAM_ID, teamId);
  } else {
    sessionStorage.removeItem(OAUTH_TEAM_ID);
  }
}

/** Mark whether this is the first installation (for auto-opening assignments dialog). */
export function setOAuthIsFirstInstallation(isFirst: boolean) {
  if (isFirst) {
    sessionStorage.setItem(OAUTH_IS_FIRST_INSTALLATION, "true");
  } else {
    sessionStorage.removeItem(OAUTH_IS_FIRST_INSTALLATION);
  }
}

/** Store the MCP server ID for re-authentication flows. */
export function setOAuthMcpServerId(serverId: string | null) {
  if (serverId) {
    sessionStorage.setItem(OAUTH_MCP_SERVER_ID, serverId);
  } else {
    sessionStorage.removeItem(OAUTH_MCP_SERVER_ID);
  }
}

/** Store a catalog ID so the catalog page opens the assignments dialog after redirect. */
export function setOAuthInstallationCompleteCatalogId(catalogId: string) {
  sessionStorage.setItem(OAUTH_INSTALLATION_COMPLETE_CATALOG_ID, catalogId);
}

/** Store the server type (e.g. "local") so the callback knows the install context. */
export function setOAuthServerType(serverType: string) {
  sessionStorage.setItem(OAUTH_SERVER_TYPE, serverType);
}

/** Store environment values collected before OAuth redirect (for local servers). */
export function setOAuthEnvironmentValues(values: Record<string, string>) {
  sessionStorage.setItem(OAUTH_ENVIRONMENT_VALUES, JSON.stringify(values));
}

/** Flag that OAuth is pending after env vars collection. */
export function setOAuthPendingAfterEnvVars(pending: boolean) {
  if (pending) {
    sessionStorage.setItem(OAUTH_PENDING_AFTER_ENV_VARS, "true");
  } else {
    sessionStorage.removeItem(OAUTH_PENDING_AFTER_ENV_VARS);
  }
}

// ─── Processing guard (prevents duplicate callback processing) ───────

export function getProcessingKey(code: string, state: string) {
  return `${OAUTH_PROCESSING_PREFIX}${code}_${state}`;
}

export function isCallbackProcessed(code: string, state: string): boolean {
  return !!sessionStorage.getItem(getProcessingKey(code, state));
}

export function markCallbackProcessing(code: string, state: string) {
  sessionStorage.setItem(getProcessingKey(code, state), "true");
}

export function clearCallbackProcessing(code: string, state: string) {
  sessionStorage.removeItem(getProcessingKey(code, state));
}

// ─── Getters ─────────────────────────────────────────────────────────

export function getOAuthMcpServerId(): string | null {
  return sessionStorage.getItem(OAUTH_MCP_SERVER_ID);
}

export function getOAuthTeamId(): string | null {
  return sessionStorage.getItem(OAUTH_TEAM_ID);
}

export function getOAuthServerType(): string | null {
  return sessionStorage.getItem(OAUTH_SERVER_TYPE);
}

export function getOAuthEnvironmentValues(): Record<string, string> | null {
  const json = sessionStorage.getItem(OAUTH_ENVIRONMENT_VALUES);
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return null;
  }
}

export function getOAuthIsFirstInstallation(): boolean {
  return sessionStorage.getItem(OAUTH_IS_FIRST_INSTALLATION) === "true";
}

export function getOAuthInstallationCompleteCatalogId(): string | null {
  return sessionStorage.getItem(OAUTH_INSTALLATION_COMPLETE_CATALOG_ID);
}

export function getOAuthPendingAfterEnvVars(): boolean {
  return sessionStorage.getItem(OAUTH_PENDING_AFTER_ENV_VARS) === "true";
}

// ─── Cleanup ─────────────────────────────────────────────────────────

/** Remove re-authentication context. */
export function clearReauthContext() {
  sessionStorage.removeItem(OAUTH_MCP_SERVER_ID);
}

/** Remove all install-flow context stored before the OAuth redirect. */
export function clearInstallContext() {
  sessionStorage.removeItem(OAUTH_STATE);
  sessionStorage.removeItem(OAUTH_CATALOG_ID);
  sessionStorage.removeItem(OAUTH_TEAM_ID);
  sessionStorage.removeItem(OAUTH_IS_FIRST_INSTALLATION);
  sessionStorage.removeItem(OAUTH_SERVER_TYPE);
  sessionStorage.removeItem(OAUTH_ENVIRONMENT_VALUES);
}

/** Remove the assignments-dialog flag. */
export function clearInstallationCompleteCatalogId() {
  sessionStorage.removeItem(OAUTH_INSTALLATION_COMPLETE_CATALOG_ID);
}

/** Remove the "pending after env vars" flag. */
export function clearPendingAfterEnvVars() {
  sessionStorage.removeItem(OAUTH_PENDING_AFTER_ENV_VARS);
}
