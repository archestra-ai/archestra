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

export const ORGANIZATION_APPEARANCE_SETTINGS_PATH =
  "/api/organization/appearance-settings";
export const PUBLIC_CONFIG_PATH = "/api/config/public";

export const INCOMING_EMAIL_WEBHOOK_PREFIX = "/api/webhooks/incoming-email";

/**
 * Reverse proxy to the public Archestra MCP catalog. Lets the browser fetch
 * catalog data via `/api/archestra-catalog/*` on its own origin (avoids CORS)
 * — this backend route is the fallback for deployments whose ingress sends
 * `/api/*` directly to the backend, bypassing the Next.js rewrite at
 * `frontend/next.config.ts`.
 */
export const ARCHESTRA_CATALOG_PROXY_PREFIX = "/api/archestra-catalog";
