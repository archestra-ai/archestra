/**
 * Scopes supported by the OAuth 2.1 authorization server.
 * Used by better-auth oauthProvider config, well-known endpoints, and consent UI.
 */
export const LLM_PROXY_OAUTH_SCOPE = "llm:proxy";

/**
 * Scope requested by MCP OAuth clients (machine-to-machine / service-account
 * access to MCP gateways via the `client_credentials` grant). Matches the scope
 * advertised in the protected-resource-metadata document.
 */
export const MCP_GATEWAY_OAUTH_SCOPE = "mcp";

export const OAUTH_SCOPES = [
  MCP_GATEWAY_OAUTH_SCOPE,
  LLM_PROXY_OAUTH_SCOPE,
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
  "llm:proxy": "Access LLM proxy endpoints",
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
 * clientId prefix for MCP OAuth clients. Used to route the `client_credentials`
 * grant at the token endpoint to the MCP issuer (vs. the LLM proxy issuer).
 */
export const MCP_OAUTH_CLIENT_ID_PREFIX = "mcp_oauth_";

/**
 * referenceId prefix that binds a client_credentials access token to the MCP
 * OAuth client that minted it. The MCP gateway validator keys its
 * service-account authorization branch on this prefix. Distinct from
 * `mcp-resource:` (per-profile enterprise-managed binding) so the existing
 * audience check passes through to the service-account branch.
 */
export const MCP_OAUTH_CLIENT_REFERENCE_PREFIX = "mcp-oauth-client:";

/**
 * Path for deep-linking to MCP catalog install dialogs.
 * Used by backend error messages and frontend routing.
 * Append `?install={catalogId}` to auto-open the install dialog.
 */
export const MCP_CATALOG_INSTALL_PATH = "/mcp/registry";
export const MCP_CATALOG_INSTALL_QUERY_PARAM = "install";

/**
 * Query params for deep-linking to the re-authentication dialog.
 * Append `?reauth={catalogId}&server={mcpServerId}` to auto-open
 * the credential dialog for in-place re-authentication.
 */
export const MCP_CATALOG_REAUTH_QUERY_PARAM = "reauth";
export const MCP_CATALOG_SERVER_QUERY_PARAM = "server";

/**
 * Query param for deep-linking to a catalog item's edit dialog.
 * Append `?edit={catalogId}` to auto-open the editor. Unlike the install/reauth
 * params, this one persists while the dialog is open so the URL stays
 * shareable. Only users who can edit the item see the editor; others get an
 * access-denied message, and unknown/invisible ids are silently ignored.
 */
export const MCP_CATALOG_EDIT_QUERY_PARAM = "edit";
