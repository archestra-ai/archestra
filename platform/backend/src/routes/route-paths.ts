/**
 * Route path constants shared across route definitions, auth middleware, sentry config,
 * and request logging filters. Centralizing these prevents drift between components
 * that need to reference the same paths.
 */

export const HEALTH_PATH = "/health";
export const READY_PATH = "/ready";
export const METRICS_PATH = "/metrics";
export const WELL_KNOWN_OAUTH_PREFIX = "/.well-known/oauth-";
/** Public OAuth redirect target; callback state is the authentication proof. */
export const OAUTH_CALLBACK_PATH = "/api/oauth/callback";
export const WELL_KNOWN_ACME_PREFIX = "/.well-known/acme-challenge/";
export const MCP_GATEWAY_PREFIX = "/v1/mcp";
/**
 * Public unauthenticated git smart-HTTP endpoint backing the skill marketplace.
 * Routes under this prefix authenticate via the URL token (no session); they
 * are allowlisted in the auth middleware in the same shape as MCP_GATEWAY_PREFIX.
 */
export const SKILL_MARKETPLACE_PREFIX = "/skills/m";

/**
 * The deployment's single, static marketplace git endpoint. Unlike
 * SKILL_MARKETPLACE_PREFIX it carries no token: the same URL is handed to
 * every user and pre-configured in their clients, and each caller
 * authenticates with their own personal credential over HTTP Basic (or clones
 * anonymously where the organization allows it). Allowlisted in the auth
 * middleware because the credential is checked in-route.
 */
export const SKILL_MARKETPLACE_STATIC_PATH = "/skills/marketplace.git";

/**
 * Public unauthenticated endpoint serving rendered connection-setup scripts.
 * The one-time setup token is embedded in the URL path; routes under this
 * prefix are allowlisted in the auth middleware and excluded from request
 * logging, in the same shape as SKILL_MARKETPLACE_PREFIX.
 */
export const CONNECTION_SETUP_SCRIPT_PREFIX = "/api/connection-setups/script";

/**
 * VAF Add On install bootstrap — the parameterless script the connector
 * form's `irm ... | iex` command fetches. Public: identical for every
 * caller, no credentials or per-user state, run in the admin's own shell.
 */
export const MFILES_VAF_ADD_ON_SCRIPT_PATH = "/api/mfiles-vaf-add-on/script";

/**
 * VAF Add On package download — the pre-built `.mfappx` the backend proxies
 * from the branch CI build when the development source-ref override is
 * active. Public: the content is a public CI artifact of the open
 * repository, and the installer fetches it without a session.
 */
export const MFILES_VAF_ADD_ON_PACKAGE_PATH = "/api/mfiles-vaf-add-on/package";

export const ORGANIZATION_APPEARANCE_SETTINGS_PATH =
  "/api/organization/appearance-settings";
export const PUBLIC_CONFIG_PATH = "/api/config/public";
/**
 * Pre-authentication auth state (is a two-factor challenge pending?). Read by
 * the auth pages before any session exists.
 */
export const AUTH_STATE_PATH = "/api/auth-state";

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
 * Where Google returns the browser after an individual Google Drive
 * authorization. Fixed, because Google matches the redirect URI exactly
 * against the one registered on the OAuth client — which is why the connector
 * being authorized travels in the signed `state` rather than in the path.
 *
 * NOT exempt from auth. The redirect is a top-level GET, which carries the
 * SameSite=Lax session cookie, so the route requires a session like any other
 * and takes `knowledgeSource: ["update"]`. The signed state is what binds the
 * response to the session that started the flow — on its own it would only
 * prove this deployment issued *some* flow, which would let one person's
 * authorization be redeemed onto another person's connector.
 */
export const GOOGLE_DRIVE_OAUTH_CALLBACK_PATH =
  "/api/connectors/gdrive/oauth/callback";

/**
 * Reverse proxy to the public Archestra MCP catalog. Lets the browser fetch
 * catalog data via `/api/archestra-catalog/*` on its own origin (avoids CORS)
 * — this backend route is the fallback for deployments whose ingress sends
 * `/api/*` directly to the backend, bypassing the Next.js rewrite at
 * `frontend/next.config.ts`.
 */
export const ARCHESTRA_CATALOG_PROXY_PREFIX = "/api/archestra-catalog";
