/**
 * Route path constants shared across route definitions, auth middleware, sentry config,
 * and request logging filters. Centralizing these prevents drift between components
 * that need to reference the same paths.
 */

export const HEALTH_PATH = "/health";
export const READY_PATH = "/ready";
export const METRICS_PATH = "/metrics";
export const WELL_KNOWN_OAUTH_PREFIX = "/.well-known/oauth-";
export const WELL_KNOWN_ACME_PREFIX = "/.well-known/acme-challenge/";
export const MCP_GATEWAY_PREFIX = "/v1/mcp";
/**
 * Public unauthenticated git smart-HTTP endpoint backing the skill marketplace.
 * Routes under this prefix authenticate via the URL token (no session); they
 * are allowlisted in the auth middleware in the same shape as MCP_GATEWAY_PREFIX.
 */
export const SKILL_MARKETPLACE_PREFIX = "/skills/m";

/**
 * Public unauthenticated endpoint serving rendered connection-setup scripts.
 * The one-time setup token is embedded in the URL path; routes under this
 * prefix are allowlisted in the auth middleware and excluded from request
 * logging, in the same shape as SKILL_MARKETPLACE_PREFIX.
 */
export const CONNECTION_SETUP_SCRIPT_PREFIX = "/api/connection-setups/script";

export const ORGANIZATION_APPEARANCE_SETTINGS_PATH =
  "/api/organization/appearance-settings";
export const PUBLIC_CONFIG_PATH = "/api/config/public";

/**
 * Public unauthenticated existence check used by the Claude Code startup
 * guard: reports whether a connected remote (MCP gateway / LLM proxy) still
 * exists, because the data-plane endpoints deliberately answer uniformly
 * (gateway: 401 whether or not the id exists; proxy: no unauthenticated GET
 * surface), so a client can't tell "deleted" from "needs auth". Discloses
 * only a boolean for a caller-supplied id/slug.
 */
/**
 * Public single-request health check for the Claude Code startup guard:
 * GET /v1/health?mcp=<id-or-slug>&llm=<id-or-slug>. Allowlisted in the auth
 * middleware; rate limited per requester and globally in the route.
 */
export const CONNECTION_HEALTH_PATH = "/v1/health";

export const INCOMING_EMAIL_WEBHOOK_PREFIX = "/api/webhooks/incoming-email";

/**
 * Reverse proxy to the public Archestra MCP catalog. Lets the browser fetch
 * catalog data via `/api/archestra-catalog/*` on its own origin (avoids CORS)
 * — this backend route is the fallback for deployments whose ingress sends
 * `/api/*` directly to the backend, bypassing the Next.js rewrite at
 * `frontend/next.config.ts`.
 */
export const ARCHESTRA_CATALOG_PROXY_PREFIX = "/api/archestra-catalog";
