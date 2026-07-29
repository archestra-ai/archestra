import type { IncomingHttpHeaders } from "node:http";
import {
  MCP_APPS_SERVER_EXTENSION_CAPABILITIES,
  MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
  MCP_OAUTH_CLIENT_CREDENTIALS_SERVER_EXTENSION_CAPABILITIES,
} from "@archestra/shared";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import type { McpServerCapabilitiesWithExtensions } from "@/types/mcp-capabilities";
import { MCP_TASKS_EXTENSION_ID } from "./tasks";

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
 * `_meta` keys carrying what `initialize` used to negotiate once per
 * connection. Under 2026-07-28 every request carries its own protocol version
 * and client capabilities, and SHOULD identify the client.
 */
export const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const MCP_PROTOCOL_VERSION_META_KEY =
  "io.modelcontextprotocol/protocolVersion";
export const MCP_CLIENT_CAPABILITIES_META_KEY =
  "io.modelcontextprotocol/clientCapabilities";

export const SERVER_DISCOVER_METHOD = "server/discover";

/**
 * Methods 2026-07-28 removes from the protocol (SEP-2575). A client that
 * declared that revision and calls one gets method-not-found — answering would
 * mean serving a revision surface the client explicitly opted out of. Clients
 * on earlier revisions are unaffected; the SDK keeps answering `ping` for
 * them, and the rest never had handlers here.
 */
export const METHODS_REMOVED_IN_STATELESS_REVISION = new Set([
  "ping",
  "logging/setLevel",
  "resources/subscribe",
  "resources/unsubscribe",
]);

export function isMethodRemovedForRevision(params: {
  method: string | undefined;
  revision: McpProtocolRevision;
}): boolean {
  const { method, revision } = params;
  return (
    revision === STATELESS_MCP_PROTOCOL_REVISION &&
    typeof method === "string" &&
    METHODS_REMOVED_IN_STATELESS_REVISION.has(method)
  );
}

/**
 * W3C Trace Context keys the revision fixes for `_meta` (SEP-414).
 *
 * Naming them in the spec is the whole value: a host, its client SDK, this
 * gateway, and the upstream server can join one span tree in an OpenTelemetry
 * backend instead of each inventing a key.
 */
export const TRACE_CONTEXT_META_KEYS = [
  "traceparent",
  "tracestate",
  "baggage",
] as const;

export type TraceContext = Partial<
  Record<(typeof TRACE_CONTEXT_META_KEYS)[number], string>
>;

/**
 * Read W3C trace context a client attached to a request.
 *
 * Returns undefined when nothing usable is present, so callers can tell "no
 * context" apart from "empty context" without inspecting the object.
 */
export function extractTraceContext(body: unknown): TraceContext | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const params = (body as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return undefined;

  const source = meta as Record<string, unknown>;
  const context: TraceContext = {};
  for (const key of TRACE_CONTEXT_META_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value !== "") {
      context[key] = value;
    }
  }

  // `traceparent` is what actually links spans; tracestate and baggage only
  // decorate it, so context without it cannot join a trace.
  return context.traceparent ? context : undefined;
}

/**
 * Error codes from the revision's allocation policy, which reserves
 * -32020..-32099 for the specification. These replace the generic JSON-RPC
 * codes an earlier draft used, so they are not interchangeable with -32600.
 */
export const HEADER_MISMATCH_ERROR_CODE = -32020;

/**
 * Missing-resource errors. SEP-2164 moved these off the MCP-specific -32002
 * onto JSON-RPC's generic Invalid Params. `isResourceUnavailableError` still
 * accepts the old code, so an upstream that has not migrated keeps working —
 * this is only what the gateway itself emits.
 */
export const RESOURCE_NOT_FOUND_ERROR_CODE = -32602;
export const UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE = -32022;

/**
 * Every result carries `resultType`. `complete` is an ordinary result;
 * `input_required` is reserved for the multi-round-trip pattern, which the
 * gateway does not implement yet. Clients treat a missing field as `complete`,
 * so emitting it is safe for older clients.
 */
export const COMPLETE_RESULT_TYPE = "complete";

/**
 * How long a cacheable result stays fresh, and who may share it (SEP-2549).
 *
 * The revision requires both fields on `tools/list`, `prompts/list`,
 * `resources/list`, `resources/read`, and `resources/templates/list`.
 *
 * `cacheScope` is always `private`: every one of those results is filtered per
 * caller by RBAC, per-agent exclusions, dynamic-tool reach, and the caller's
 * own upstream credentials, so two users hitting the same agent legitimately
 * see different results. `public` would let a shared intermediary serve one
 * caller's view to another.
 */
export const LIST_CACHE_TTL_MS = 30_000;
export const PRIVATE_CACHE_SCOPE = "private";

export type CacheHint = {
  ttlMs: number;
  cacheScope: typeof PRIVATE_CACHE_SCOPE;
};

/**
 * Cache hints for a per-caller cacheable result.
 *
 * Emitted to every client regardless of negotiated revision: unknown result
 * fields are preserved rather than rejected by the 2025-11-25 result schemas,
 * so legacy clients simply ignore them.
 */
export function buildPrivateListCacheHint(): CacheHint {
  return {
    ttlMs: LIST_CACHE_TTL_MS,
    cacheScope: PRIVATE_CACHE_SCOPE,
  };
}

/**
 * `_meta` key servers use to identify themselves on each result, replacing what
 * `initialize` reported once per connection.
 */
export const MCP_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

/**
 * Stamp a result as an ordinary, complete one and identify the server.
 *
 * Every result carries `resultType` in this revision; `complete` is the
 * ordinary case, as opposed to the `input_required` interim result MRTR
 * returns. Older clients treat a missing field as `complete`, so emitting it
 * unconditionally is safe for both revisions.
 */
export function withCompleteResultEnvelope<T extends object>(
  result: T,
  serverInfo: { name: string; version: string },
): T {
  const existingMeta = (result as { _meta?: Record<string, unknown> })._meta;
  return {
    ...result,
    resultType: COMPLETE_RESULT_TYPE,
    _meta: {
      ...existingMeta,
      [MCP_SERVER_INFO_META_KEY]: serverInfo,
    },
  } as T;
}

/**
 * Attach cache hints to a result produced elsewhere (e.g. proxied from an
 * upstream server) without disturbing its existing fields.
 */
export function withPrivateCacheHint<T extends object>(
  result: T,
): T & CacheHint {
  return { ...result, ...buildPrivateListCacheHint() };
}

/**
 * Server capabilities advertised by the gateway, shared by the `initialize`
 * response (built by the SDK from these) and by `server/discover`, so the two
 * revisions can never drift apart.
 */
export function buildGatewayServerCapabilities(
  revision: McpProtocolRevision = LEGACY_MCP_PROTOCOL_REVISION,
): McpServerCapabilitiesWithExtensions {
  return {
    // Neither subscription flag is advertised, in any revision, because
    // neither was ever implemented: no `resources/subscribe` handler exists —
    // callers always got method-not-found — and no `list_changed`
    // notification has ever been sent (the stateless transport has no channel
    // to carry one). Advertising them cost real behavior: a client seeing
    // `listChanged: true` may cache its lists indefinitely waiting for a
    // notification that never comes. Freshness is signalled by the SEP-2549
    // `ttlMs`/`cacheScope` hints on every cacheable result instead. In
    // 2026-07-28 `resources/subscribe` is removed outright in favour of
    // `subscriptions/listen`, which the gateway can advertise if it ever
    // grows an event source to back it.
    resources: {
      listChanged: false,
    },
    extensions: {
      // Tasks negotiation rides per-request _meta capabilities, which exist
      // only on the stateless revision; the task methods are gated the same
      // way, so a legacy client is not shown an extension it cannot invoke.
      ...(revision === STATELESS_MCP_PROTOCOL_REVISION
        ? { [MCP_TASKS_EXTENSION_ID]: {} }
        : {}),
      ...MCP_APPS_SERVER_EXTENSION_CAPABILITIES,
      ...MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
      ...MCP_OAUTH_CLIENT_CREDENTIALS_SERVER_EXTENSION_CAPABILITIES,
    },
    prompts: {},
    tools: {
      // Backed by `subscriptions/listen` fingerprint polling, which exists
      // only on the stateless revision — a legacy client has no channel a
      // notification could arrive on, so advertising it there would recreate
      // the wait-forever caching problem this flag used to cause.
      listChanged: revision === STATELESS_MCP_PROTOCOL_REVISION,
    },
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
 * A client declares its version either in the `MCP-Protocol-Version` header or
 * in `params._meta` — the revision moved per-request version carriage into
 * `_meta`, so a conforming client may send only that. Either is treated as an
 * explicit declaration.
 *
 * Failing that the request is inferred from the remaining 2026-07-28 markers,
 * the routing headers and the per-request `clientInfo` key, none of which a
 * 2025-11-25 client sends. Anything else — notably a bare `initialize` — falls
 * back to the legacy revision, so existing clients are unaffected.
 */
export function resolveProtocolRevision(params: {
  headers: IncomingHttpHeaders;
  body: unknown;
}): ProtocolResolution | ProtocolError {
  const { headers, body } = params;

  const declared =
    readHeader(headers, MCP_PROTOCOL_VERSION_HEADER) ??
    readMetaProtocolVersion(body);
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
      code: UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
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
      code: HEADER_MISMATCH_ERROR_CODE,
      message: `Routing header mismatch: ${MCP_METHOD_HEADER} "${headerMethod}" does not match request method "${method}".`,
    };
  }

  if (
    headerName !== undefined &&
    targetName !== undefined &&
    headerName !== targetName
  ) {
    return {
      code: HEADER_MISMATCH_ERROR_CODE,
      message: `Routing header mismatch: ${MCP_NAME_HEADER} "${headerName}" does not match request target "${targetName}".`,
    };
  }

  // A `Mcp-Name` on a method that addresses no target is meaningless and would
  // route a request somewhere its body never asked to go.
  if (headerName !== undefined && targetName === undefined) {
    return {
      code: HEADER_MISMATCH_ERROR_CODE,
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
      code: HEADER_MISMATCH_ERROR_CODE,
      message: `Missing required ${MCP_METHOD_HEADER} header for protocol version ${STATELESS_MCP_PROTOCOL_REVISION}.`,
    };
  }

  if (targetName !== undefined && headerName === undefined) {
    return {
      code: HEADER_MISMATCH_ERROR_CODE,
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
    resultType: COMPLETE_RESULT_TYPE,
    // The revision has servers advertise every version they support, not just
    // the one this request used, so a client can pick before committing.
    protocolVersions: [...SUPPORTED_MCP_PROTOCOL_REVISIONS],
    // The single negotiated version stays alongside it for clients written
    // against the earlier draft, where discover returned only this.
    protocolVersion: revision,
    serverInfo: {
      name: `archestra-agent-${agentId}`,
      version,
    },
    capabilities: buildGatewayServerCapabilities(revision),
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

function readMeta(body: unknown): Record<string, unknown> | undefined {
  const meta = readParams(body)?._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  return meta as Record<string, unknown>;
}

function readMetaProtocolVersion(body: unknown): string | undefined {
  const value = readMeta(body)?.[MCP_PROTOCOL_VERSION_META_KEY];
  return typeof value === "string" ? value : undefined;
}

function hasStatelessClientInfo(body: unknown): boolean {
  const meta = readMeta(body);
  if (!meta) return false;
  return (
    MCP_CLIENT_INFO_META_KEY in meta || MCP_CLIENT_CAPABILITIES_META_KEY in meta
  );
}
