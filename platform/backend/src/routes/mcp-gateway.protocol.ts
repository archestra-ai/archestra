import type { IncomingHttpHeaders } from "node:http";
import {
  MCP_APPS_SERVER_EXTENSION_CAPABILITIES,
  MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
  MCP_OAUTH_CLIENT_CREDENTIALS_SERVER_EXTENSION_CAPABILITIES,
} from "@archestra/shared";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import type { McpServerCapabilitiesWithExtensions } from "@/types/mcp-capabilities";

/**
 * MCP protocol revision support for the gateway.
 *
 * The gateway speaks two revisions from the same endpoint:
 *
 * - `2025-11-25` — the stateful-handshake revision. Clients POST `initialize`,
 *   and the SDK transport answers it.
 * - `2026-07-28` — the stateless revision. `initialize`/`initialized` are gone
 *   (SEP-2575) along with `Mcp-Session-Id` (SEP-2567); clients carry their
 *   identity in `params._meta` on every request and ask for capabilities up
 *   front via `server/discover`. Streamable HTTP additionally mandates
 *   `Mcp-Method`/`Mcp-Name` routing headers (SEP-2243).
 *
 * The gateway transport has always run stateless (no session id generator), so
 * the wire change is additive rather than a migration: legacy clients keep the
 * handshake, new clients get `server/discover` plus header validation, and both
 * receive the same tool surface.
 */

export const LEGACY_MCP_PROTOCOL_REVISION = "2025-11-25";
export const STATELESS_MCP_PROTOCOL_REVISION = "2026-07-28";

/**
 * Ordered newest-first, which is also the order advertised to clients.
 *
 * This is what the gateway *advertises*, not the full set it accepts: the
 * pre-2025-11-25 revisions the bundled SDK still negotiates stay accepted (see
 * `resolveProtocolRevision`) so this negotiation layer cannot turn away a
 * client that worked before it existed.
 */
export const SUPPORTED_MCP_PROTOCOL_REVISIONS = [
  STATELESS_MCP_PROTOCOL_REVISION,
  LEGACY_MCP_PROTOCOL_REVISION,
] as const;

/**
 * Which of the two wire behaviours a request gets. Older revisions all resolve
 * to the legacy behaviour and are handed to the SDK, which negotiates the exact
 * version itself as it always has.
 */
export type McpProtocolRevision =
  (typeof SUPPORTED_MCP_PROTOCOL_REVISIONS)[number];

export const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
export const MCP_METHOD_HEADER = "mcp-method";
export const MCP_NAME_HEADER = "mcp-name";

/**
 * `_meta` key carrying client identity on every request under 2026-07-28,
 * replacing what `initialize` negotiated once per connection.
 */
export const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

export const SERVER_DISCOVER_METHOD = "server/discover";

/**
 * How long a `tools/list` result stays fresh, and who may share it (SEP-2549).
 *
 * `cacheScope` is always `private`: the gateway's tool list is filtered per
 * caller by RBAC, per-agent exclusions, and dynamic-tool reach, so two users
 * hitting the same agent legitimately see different lists. Advertising a
 * shared scope would let an intermediary serve one caller's tool visibility to
 * another.
 */
export const TOOLS_LIST_CACHE_TTL_MS = 30_000;
export const PRIVATE_CACHE_SCOPE = "private";

export type CacheHint = {
  ttlMs: number;
  cacheScope: typeof PRIVATE_CACHE_SCOPE;
};

/**
 * Cache hints for a per-caller list result.
 *
 * Emitted to every client regardless of negotiated revision: unknown result
 * fields are preserved rather than rejected by the 2025-11-25 result schemas,
 * so legacy clients simply ignore them.
 */
export function buildPrivateListCacheHint(): CacheHint {
  return {
    ttlMs: TOOLS_LIST_CACHE_TTL_MS,
    cacheScope: PRIVATE_CACHE_SCOPE,
  };
}

/**
 * Server capabilities advertised by the gateway, shared by the `initialize`
 * response (built by the SDK from these) and by `server/discover`, so the two
 * revisions can never drift apart.
 */
export function buildGatewayServerCapabilities(): McpServerCapabilitiesWithExtensions {
  return {
    resources: {
      subscribe: true,
      listChanged: true,
    },
    extensions: {
      ...MCP_APPS_SERVER_EXTENSION_CAPABILITIES,
      ...MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
      ...MCP_OAUTH_CLIENT_CREDENTIALS_SERVER_EXTENSION_CAPABILITIES,
    },
    prompts: {},
    tools: { listChanged: false },
  } as McpServerCapabilitiesWithExtensions;
}

export type ProtocolResolution = {
  revision: McpProtocolRevision;
  /**
   * Whether the client named the revision itself (via `MCP-Protocol-Version`).
   * Only an explicit declaration makes the 2026-07-28 routing headers
   * mandatory — a client merely inferred to be stateless is still given the
   * benefit of the doubt.
   */
  declaredExplicitly: boolean;
  /**
   * The exact version string the client sent, which for a legacy client can be
   * older than `revision` (e.g. `2024-11-05`). Echoed back verbatim so the
   * response never claims a newer version than the client asked for.
   */
  declaredVersion?: string;
};

export type ProtocolError = {
  code: number;
  message: string;
};

/**
 * Decide which revision a request speaks.
 *
 * An explicit `MCP-Protocol-Version` header wins. Otherwise the request is
 * inferred: the 2026-07-28 markers are the routing headers and the per-request
 * `clientInfo` `_meta` key, none of which a 2025-11-25 client sends. Anything
 * else — notably a bare `initialize` — falls back to the legacy revision, so
 * existing clients are unaffected by this negotiation.
 */
export function resolveProtocolRevision(params: {
  headers: IncomingHttpHeaders;
  body: unknown;
}): ProtocolResolution | ProtocolError {
  const { headers, body } = params;

  const declared = readHeader(headers, MCP_PROTOCOL_VERSION_HEADER);
  if (declared) {
    if (declared === STATELESS_MCP_PROTOCOL_REVISION) {
      return {
        revision: STATELESS_MCP_PROTOCOL_REVISION,
        declaredExplicitly: true,
        declaredVersion: declared,
      };
    }

    // Every revision the bundled SDK negotiates keeps the legacy behaviour,
    // including the pre-2025-11-25 ones. Narrowing acceptance to just the two
    // advertised revisions would reject clients that worked before this
    // negotiation layer existed.
    if (SDK_SUPPORTED_PROTOCOL_VERSIONS.includes(declared)) {
      return {
        revision: LEGACY_MCP_PROTOCOL_REVISION,
        declaredExplicitly: true,
        declaredVersion: declared,
      };
    }

    return {
      code: -32600,
      message: `Unsupported MCP protocol version "${declared}". Supported versions: ${[
        ...SUPPORTED_MCP_PROTOCOL_REVISIONS,
        ...SDK_SUPPORTED_PROTOCOL_VERSIONS.filter(
          (version) => version !== LEGACY_MCP_PROTOCOL_REVISION,
        ),
      ].join(", ")}.`,
    };
  }

  if (
    readHeader(headers, MCP_METHOD_HEADER) !== undefined ||
    hasStatelessClientInfo(body)
  ) {
    return {
      revision: STATELESS_MCP_PROTOCOL_REVISION,
      declaredExplicitly: false,
    };
  }

  return { revision: LEGACY_MCP_PROTOCOL_REVISION, declaredExplicitly: false };
}

/**
 * The `Mcp-Name` value a request implies, or undefined for methods that do not
 * address a single named target (`tools/list`, `server/discover`, ...).
 */
export function deriveRequestTargetName(body: unknown): string | undefined {
  const method = readMethod(body);
  if (!method) return undefined;

  const params = readParams(body);
  if (!params) return undefined;

  switch (method) {
    case "tools/call":
    case "prompts/get":
      return typeof params.name === "string" ? params.name : undefined;
    case "resources/read":
      return typeof params.uri === "string" ? params.uri : undefined;
    default:
      return undefined;
  }
}

/**
 * Enforce SEP-2243 routing headers.
 *
 * Two separate jobs:
 *
 * 1. When a header is present it MUST agree with the body. The spec requires
 *    rejecting mismatches, and the requirement is load-bearing rather than
 *    cosmetic — the headers exist so intermediaries can dispatch without
 *    parsing the body, so a header that disagrees with the body it fronts is
 *    exactly the shape of a policy bypass.
 * 2. When the client explicitly declared 2026-07-28, the headers are required.
 *
 * Notifications (no `id`) and legacy requests are exempt from (2).
 */
export function validateRoutingHeaders(params: {
  headers: IncomingHttpHeaders;
  body: unknown;
  resolution: ProtocolResolution;
}): ProtocolError | null {
  const { headers, body, resolution } = params;

  const method = readMethod(body);
  if (!method) return null;

  const headerMethod = readHeader(headers, MCP_METHOD_HEADER);
  const headerName = readHeader(headers, MCP_NAME_HEADER);
  const targetName = deriveRequestTargetName(body);

  if (headerMethod !== undefined && headerMethod !== method) {
    return {
      code: -32600,
      message: `Routing header mismatch: ${MCP_METHOD_HEADER} "${headerMethod}" does not match request method "${method}".`,
    };
  }

  if (
    headerName !== undefined &&
    targetName !== undefined &&
    headerName !== targetName
  ) {
    return {
      code: -32600,
      message: `Routing header mismatch: ${MCP_NAME_HEADER} "${headerName}" does not match request target "${targetName}".`,
    };
  }

  // A `Mcp-Name` on a method that addresses no target is meaningless and would
  // route a request somewhere its body never asked to go.
  if (headerName !== undefined && targetName === undefined) {
    return {
      code: -32600,
      message: `Routing header mismatch: ${MCP_NAME_HEADER} was sent for method "${method}", which addresses no named target.`,
    };
  }

  const requiresHeaders =
    resolution.declaredExplicitly &&
    resolution.revision === STATELESS_MCP_PROTOCOL_REVISION &&
    isRequest(body);

  if (!requiresHeaders) return null;

  if (headerMethod === undefined) {
    return {
      code: -32600,
      message: `Missing required ${MCP_METHOD_HEADER} header for protocol version ${STATELESS_MCP_PROTOCOL_REVISION}.`,
    };
  }

  if (targetName !== undefined && headerName === undefined) {
    return {
      code: -32600,
      message: `Missing required ${MCP_NAME_HEADER} header for method "${method}" under protocol version ${STATELESS_MCP_PROTOCOL_REVISION}.`,
    };
  }

  return null;
}

export function isDiscoverRequest(body: unknown): boolean {
  return readMethod(body) === SERVER_DISCOVER_METHOD;
}

/**
 * The `server/discover` result — the capability payload that `initialize`
 * returned under 2025-11-25, now fetched on demand instead of as a handshake.
 */
export function buildDiscoverResult(params: {
  agentId: string;
  version: string;
  revision: McpProtocolRevision;
}) {
  const { agentId, version, revision } = params;
  return {
    protocolVersion: revision,
    serverInfo: {
      name: `archestra-agent-${agentId}`,
      version,
    },
    capabilities: buildGatewayServerCapabilities(),
  };
}

/**
 * Whether a JSON-RPC error means "the upstream server cannot serve this
 * resource" rather than a platform fault.
 *
 * SEP-2164 moved missing-resource errors off the MCP-specific `-32002` onto
 * JSON-RPC's generic `-32602` (Invalid Params). `-32602` cannot be treated as
 * not-found on the code alone — it is also what a genuinely malformed argument
 * returns, and swallowing those would hide real bugs — so the newer code only
 * counts when the message says the resource is missing.
 */
export function isResourceUnavailableError(params: {
  code: unknown;
  message?: string;
}): boolean {
  const { code, message } = params;

  if (code === -32601 || code === -32002) return true;

  if (code === -32602) {
    return typeof message === "string" && NOT_FOUND_MESSAGE.test(message);
  }

  return false;
}

// =============================================================================
// Internal helpers
// =============================================================================

const NOT_FOUND_MESSAGE =
  /resource not found|not found|unknown (resource|uri)/i;

/**
 * Read from the SDK rather than re-listed here, so an SDK upgrade that adds or
 * drops a revision cannot silently disagree with what the gateway accepts.
 */
const SDK_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] =
  SUPPORTED_PROTOCOL_VERSIONS;

function readHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function readMethod(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function readParams(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const params = (body as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return undefined;
  return params as Record<string, unknown>;
}

/**
 * JSON-RPC requests carry an `id`; notifications do not.
 */
function isRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const id = (body as { id?: unknown }).id;
  return id !== undefined && id !== null;
}

function hasStatelessClientInfo(body: unknown): boolean {
  const params = readParams(body);
  const meta = params?._meta;
  if (typeof meta !== "object" || meta === null) return false;
  return MCP_CLIENT_INFO_META_KEY in (meta as Record<string, unknown>);
}
