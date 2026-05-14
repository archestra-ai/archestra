/**
 * Scopes supported by the OAuth 2.1 authorization server.
 * Used by better-auth oauthProvider config, well-known endpoints, and consent UI.
 */
export const LLM_PROXY_OAUTH_SCOPE = "llm:proxy";

export const OAUTH_SCOPES = [
  "mcp",
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
