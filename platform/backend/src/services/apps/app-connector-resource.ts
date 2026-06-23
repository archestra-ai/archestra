import {
  MCP_APP_RESOURCE_REFERENCE_PREFIX,
  MCP_GATEWAY_OAUTH_SCOPE,
} from "@archestra/shared";

/**
 * The shareable MCP App connector's OAuth resource identity. A connector URL
 * (`/api/mcp/app/:appId`) is an RFC 8707 resource: an access token is minted
 * audience-bound to its canonical URI and accepted only at that connector.
 * These pure helpers are shared by the mint side (the token endpoint) and the
 * validate side (the connector), so both derive the identical canonical string.
 */

/** Route segment a connector URL lives under, e.g. `/api/mcp/app/<appId>`. */
export const APP_CONNECTOR_PATH_PREFIX = "/api/mcp/app/";

const CONNECTOR_PATH_RE = /^\/api\/mcp\/app\/([^/]+)$/;

/**
 * Canonicalize a connector resource URI per RFC 8707: lowercased host,
 * no trailing slash, no query, no fragment. Returns null when the input is not
 * a well-formed `http(s)` connector URL — so a token can never be bound to an
 * arbitrary URL. The scheme is preserved (https in production, http in local
 * dev) since both sides derive it from the same request origin.
 *
 * @public — exercised directly by app-connector-resource.test.ts
 */
export function canonicalizeConnectorResourceUri(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!CONNECTOR_PATH_RE.test(path)) {
    return null;
  }
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/**
 * Canonicalize a client-supplied `resource` only when its origin is trusted, so
 * the token endpoint never stamps a binding to an origin it does not serve.
 */
export function resolveAppConnectorResource(
  raw: unknown,
  allowedOrigins: Set<string>,
): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const canonical = canonicalizeConnectorResourceUri(raw);
  if (!canonical) {
    return null;
  }
  // Compare both sides as normalized `URL.origin` (lowercased host, default
  // :80/:443 stripped). `allowedOrigins` is built from request-derived strings
  // (a Host/X-Forwarded-Host that may carry a mixed-case host or an explicit
  // default port), while the canonical origin is already normalized — a raw
  // string compare would reject a valid resource and leave the token unbound.
  const target = new URL(canonical).origin;
  for (const origin of allowedOrigins) {
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      continue;
    }
    if (normalized === target) {
      return canonical;
    }
  }
  return null;
}

/**
 * Whether a client-supplied `resource` targets a connector path at all — any
 * `/api/mcp/app/...` URL — including one that fails {@link
 * resolveAppConnectorResource} (an untrusted origin, or a sub-path). The token
 * endpoint uses this to fail closed (RFC 8707 `invalid_target`) on a
 * connector-intended `resource` it cannot bind, rather than fall through to an
 * unbound token that would still authenticate the MCP gateway.
 */
export function isConnectorTargetedResource(raw: unknown): boolean {
  if (typeof raw !== "string") {
    return false;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.pathname.startsWith(APP_CONNECTOR_PATH_PREFIX);
}

/** The connector's own canonical resource URI, derived from the request origin. */
export function buildConnectorResourceUri(
  origin: string,
  appId: string,
): string | null {
  return canonicalizeConnectorResourceUri(
    `${origin}${APP_CONNECTOR_PATH_PREFIX}${appId}`,
  );
}

/** The `referenceId` value that binds a token to a connector's canonical URI. */
export function appConnectorAudienceRef(canonicalUri: string): string {
  return `${MCP_APP_RESOURCE_REFERENCE_PREFIX}${canonicalUri}`;
}

/**
 * Whether a token's `referenceId` binds it to a shareable App connector. Other
 * OAuth resource validators (the MCP gateway, the LLM proxy) call this to reject
 * a connector-bound token presented at a resource it was not issued for.
 */
export function isAppConnectorAudienceRef(
  referenceId: string | null | undefined,
): boolean {
  return (
    typeof referenceId === "string" &&
    referenceId.startsWith(MCP_APP_RESOURCE_REFERENCE_PREFIX)
  );
}

/**
 * The connector's canonical resource URI recovered from a token's audience ref,
 * or null when the ref does not bind to a connector. Inverse of {@link
 * appConnectorAudienceRef}: lets the token endpoint resolve the owning app from
 * a refreshed token, whose binding better-auth inherits without re-sending the
 * `resource`.
 */
export function connectorResourceUriFromAudienceRef(
  referenceId: string | null | undefined,
): string | null {
  if (
    typeof referenceId !== "string" ||
    !referenceId.startsWith(MCP_APP_RESOURCE_REFERENCE_PREFIX)
  ) {
    return null;
  }
  return referenceId.slice(MCP_APP_RESOURCE_REFERENCE_PREFIX.length) || null;
}

/**
 * The RFC 9728 `WWW-Authenticate: Bearer` challenge for a connector, pointing a
 * client at the connector's protected-resource metadata and the scope to
 * request. Emitted by both the auth middleware (a credential-less discovery
 * request) and the route (an invalid token).
 */
export function connectorWwwAuthenticate(
  origin: string,
  appId: string,
): string {
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource${APP_CONNECTOR_PATH_PREFIX}${appId}`;
  return `Bearer resource_metadata="${resourceMetadataUrl}", scope="${MCP_GATEWAY_OAUTH_SCOPE}"`;
}

/** The app id in a connector request path, e.g. `/api/mcp/app/<appId>`. */
export function appIdFromConnectorPath(pathname: string): string | null {
  if (!pathname.startsWith(APP_CONNECTOR_PATH_PREFIX)) {
    return null;
  }
  const rest = pathname.slice(APP_CONNECTOR_PATH_PREFIX.length);
  const appId = rest.split(/[/?#]/, 1)[0];
  return appId || null;
}
