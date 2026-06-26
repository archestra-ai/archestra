import { OAUTH_ENDPOINTS } from "@archestra/shared";
import type { FastifyCorsOptions } from "@fastify/cors";
import type { FastifyRequest } from "fastify";

import { WELL_KNOWN_OAUTH_PREFIX } from "./route-paths";

/**
 * Public OAuth 2.1 authorization-server endpoints that browser-based MCP clients
 * call cross-origin during the OAuth handshake: metadata discovery
 * (`/.well-known/oauth-*`), dynamic client registration, the token endpoint, and
 * the JWKS endpoint. These are unauthenticated, PKCE/public-client safe, and
 * never rely on the session cookie, so — per the OAuth-for-browser-apps guidance
 * and the MCP authorization spec — they must be reachable from any origin, not
 * just the configured frontend. The default (restricted, credentialed) CORS
 * policy otherwise blocks a web-based MCP client whose origin isn't allow-listed.
 *
 * The browser-facing `authorize` endpoint is intentionally excluded here: it is
 * a top-level navigation rather than a CORS fetch and depends on the session
 * cookie. It gets its own CORS-disabled policy — see {@link isOAuthAuthorizePath}.
 */
const PUBLIC_OAUTH_CORS_PATHS: string[] = [
  OAUTH_ENDPOINTS.token,
  OAUTH_ENDPOINTS.register,
  OAUTH_ENDPOINTS.jwks,
];

/**
 * True when `url` targets a public OAuth endpoint that should serve permissive
 * (any-origin, credential-less) CORS. Matches the OAuth metadata well-known
 * paths — including their per-resource subpaths, e.g.
 * `/.well-known/oauth-protected-resource/v1/mcp/<id>` — plus the token,
 * registration, and JWKS endpoints. The query string is ignored.
 */
export function isPublicOAuthCorsPath(url: string): boolean {
  const path = url.split("?")[0];
  if (path.startsWith(WELL_KNOWN_OAUTH_PREFIX)) {
    return true;
  }
  return PUBLIC_OAUTH_CORS_PATHS.some(
    (endpoint) => path === endpoint || path.startsWith(`${endpoint}/`),
  );
}

/**
 * True when `url` targets the browser-facing OAuth `authorize` endpoint. This
 * endpoint is only ever reached as a top-level navigation that carries the
 * session cookie (the OAuth metadata advertises it at the frontend's own
 * origin); a legitimate cross-origin programmatic fetch of it never happens.
 * It therefore gets a CORS-disabled policy: no `Access-Control-Allow-Origin` is
 * emitted, so the browser blocks any cross-origin fetch while top-level
 * navigation — which is not subject to CORS — keeps working. Because the
 * browser enforces this structurally, the endpoint needs no configured-origin
 * allow-list, unlike the credentialed `restricted` policy. The query string is
 * ignored.
 */
export function isOAuthAuthorizePath(url: string): boolean {
  const path = url.split("?")[0];
  return (
    path === OAUTH_ENDPOINTS.authorize ||
    path.startsWith(`${OAUTH_ENDPOINTS.authorize}/`)
  );
}

type CorsOptionsCallback = (
  err: Error | null,
  options: FastifyCorsOptions,
) => void;

/**
 * Build the per-request CORS options resolver for `@fastify/cors`:
 * - the browser-facing `authorize` endpoint (see {@link isOAuthAuthorizePath})
 *   gets `authorizeDisabled` (CORS off);
 * - public OAuth endpoints (see {@link isPublicOAuthCorsPath}) get `publicOAuth`;
 * - every other route gets `restricted`.
 * Registered via the plugin's function-as-options form:
 * `fastify.register(fastifyCors, createOAuthAwareCorsDelegate(...))`.
 */
export function createOAuthAwareCorsDelegate(params: {
  restricted: FastifyCorsOptions;
  publicOAuth: FastifyCorsOptions;
  authorizeDisabled: FastifyCorsOptions;
}): () => (req: FastifyRequest, callback: CorsOptionsCallback) => void {
  const { restricted, publicOAuth, authorizeDisabled } = params;
  return () => (req, callback) => {
    if (isOAuthAuthorizePath(req.url)) {
      callback(null, authorizeDisabled);
      return;
    }
    callback(null, isPublicOAuthCorsPath(req.url) ? publicOAuth : restricted);
  };
}
