import { randomUUID } from "node:crypto";
import { LOOPBACK_HOST } from "@archestra/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { trackBackgroundWork } from "@/utils/background-work";
import {
  MCP_PROTOCOL_VERSION_HEADER,
  STATELESS_MCP_PROTOCOL_REVISION,
} from "./protocol";

/**
 * Legacy clients POST messages to the endpoint announced by their GET stream.
 * Replay through the existing gateway to preserve authentication and tool handling.
 * Replies for another replica wait in the shared cache until its next poll.
 */

/** Last path segment of the message endpoint a stream announces. */
export const LEGACY_SSE_MESSAGES_SEGMENT = "messages";

/** Abandoned replies expire after ten minutes. */
const MESSAGE_TTL_MS = 10 * 60_000;

/** SSE comment cadence, so idle timeouts along the path don't kill the stream. */
const HEARTBEAT_MS = 25_000;

/** Maximum stream lifetime; the heartbeat closes it when the record expires. */
const LEGACY_SSE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How often a pod looks for answers another replica parked for its streams. */
const MESSAGE_POLL_MS = 1_000;

/** Bound gateway calls, including built-in tools without upstream timeouts. */
const REPLAY_TIMEOUT_MS = 5 * 60_000;

/** Hop-by-hop headers, plus the ones the replay sets itself. */
const HEADERS_NOT_FORWARDED = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "transfer-encoding",
  "upgrade",
]);

type JsonRpcMessage = Record<string, unknown>;

/** What a stream was opened for, kept in the shared cache while it lives. */
interface LegacySseSessionRecord {
  profileId: string;
  principal: string;
}

interface LegacySseSession {
  readonly sessionId: string;
  deliver(message: JsonRpcMessage): void;
  end(): void;
}

/** The streams this process holds, one registry per gateway plugin instance. */
export class LegacySseSessionRegistry {
  private readonly sessions = new Map<string, LegacySseSession>();
  private readonly poller: NodeJS.Timeout;
  private draining = false;

  constructor() {
    this.poller = setInterval(() => this.pollMessages(), MESSAGE_POLL_MS);
    // Never keep the process alive just to poll.
    this.poller.unref();
  }

  get(sessionId: string): LegacySseSession | undefined {
    return this.sessions.get(sessionId);
  }

  add(session: LegacySseSession): void {
    this.sessions.set(session.sessionId, session);
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Stop polling and end every stream, so clients reconnect elsewhere. */
  close(): void {
    clearInterval(this.poller);
    for (const session of this.sessions.values()) {
      session.end();
    }
  }

  /** One tick: deliver whatever other replicas parked for these streams. */
  private pollMessages(): void {
    const sessionIds = [...this.sessions.keys()];
    if (sessionIds.length === 0 || this.draining) return;
    this.draining = true;
    trackBackgroundWork(
      cacheManager
        .getAndDeleteMany<JsonRpcMessage[]>(sessionIds.map(messageCacheKey))
        .then((entries) => {
          for (const { key, value: messages } of entries) {
            const sessionId = key.slice(
              `${CacheKey.LegacySseMessages}-`.length,
            );
            for (const message of messages)
              this.sessions.get(sessionId)?.deliver(message);
          }
        })
        .catch((error) => {
          // A transient failure must not kill long-lived streams; the next
          // tick reads again.
          logger.debug({ error }, "Legacy SSE message poll failed; will retry");
        })
        .finally(() => {
          this.draining = false;
        }),
    );
  }
}

/** The stateless revision uses subscriptions/listen instead of a GET stream. */
export function wantsLegacySseStream(request: FastifyRequest): boolean {
  const declared = request.headers[MCP_PROTOCOL_VERSION_HEADER];
  return (
    (request.headers.accept ?? "").includes("text/event-stream") &&
    declared !== STATELESS_MCP_PROTOCOL_REVISION
  );
}

/** Load the gateway and principal associated with an announced stream. */
export async function loadLegacySseSession(
  sessionId: string,
): Promise<LegacySseSessionRecord | undefined> {
  return cacheManager.get<LegacySseSessionRecord>(sessionCacheKey(sessionId));
}

/** Open an authenticated stream and announce its message endpoint. */
export async function openLegacySseStream(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  profileId: string;
  principal: string;
  registry: LegacySseSessionRegistry;
}): Promise<void> {
  const { request, reply, profileId, principal, registry } = params;
  const sessionId = randomUUID();
  // Recorded before the reply is hijacked, so a cache failure surfaces as an
  // ordinary 500 rather than a stream nothing can ever POST to.
  await cacheManager.set(
    sessionCacheKey(sessionId),
    { profileId, principal } satisfies LegacySseSessionRecord,
    LEGACY_SSE_SESSION_TTL_MS,
  );
  // The endpoint is this stream's own path plus `/messages`. The SDK client
  // resolves it against the stream URL and requires the same origin.
  const endpoint = `${requestPath(request)}/${LEGACY_SSE_MESSAGES_SEGMENT}?sessionId=${sessionId}`;

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  reply.raw.write(`event: endpoint\ndata: ${endpoint}\n\n`);

  let closed = false;
  const write = (chunk: string): void => {
    if (!closed) reply.raw.write(chunk);
  };
  const deliver = (message: JsonRpcMessage): void => {
    write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  };
  const expiresAt = Date.now() + LEGACY_SSE_SESSION_TTL_MS;
  const heartbeat = setInterval(() => {
    if (Date.now() >= expiresAt) {
      finish();
      reply.raw.end();
    } else {
      write(": keep-alive\n\n");
    }
  }, HEARTBEAT_MS);

  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    registry.remove(sessionId);
    trackBackgroundWork(
      Promise.all([
        cacheManager.delete(sessionCacheKey(sessionId)),
        cacheManager.delete(messageCacheKey(sessionId)),
      ]),
    );
    logger.debug({ profileId, sessionId }, "MCP legacy SSE stream closed");
  };

  registry.add({
    sessionId,
    deliver,
    end: () => {
      finish();
      reply.raw.end();
    },
  });
  reply.raw.on("close", finish);
  logger.debug({ profileId, sessionId }, "MCP legacy SSE stream opened");
}

/** Execute an acknowledged message and deliver its response to the stream. */
export async function dispatchLegacySseMessage(params: {
  request: FastifyRequest;
  registry: LegacySseSessionRegistry;
  sessionId: string;
  profileId: string;
  message: JsonRpcMessage;
}): Promise<void> {
  const { request, registry, sessionId, profileId, message } = params;
  const requestId = readRequestId(message);

  let answer: JsonRpcMessage | undefined;
  try {
    answer = await replayThroughGateway({
      request,
      profileId,
      message,
      requestId,
    });
  } catch (error) {
    logger.warn(
      { error, profileId, sessionId, method: message.method },
      "Legacy SSE message could not be replayed through the gateway",
    );
    if (requestId !== undefined) {
      answer = {
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32603, message: "Internal error" },
      };
    }
  }

  if (!answer) return;
  const local = registry.get(sessionId);
  if (local) {
    local.deliver(answer);
  } else {
    // Atomic append preserves concurrent tool responses for the same stream.
    await cacheManager.appendToList({
      key: messageCacheKey(sessionId),
      value: answer,
      ttl: MESSAGE_TTL_MS,
    });
  }
}

// =============================================================================
// Internal
// =============================================================================

function messageCacheKey(sessionId: string): AllowedCacheKey {
  return `${CacheKey.LegacySseMessages}-${sessionId}`;
}

function sessionCacheKey(sessionId: string): AllowedCacheKey {
  return `${CacheKey.LegacySseSession}-${sessionId}`;
}

/**
 * Run the message through the existing route and return its JSON-RPC response.
 */
async function replayThroughGateway(params: {
  request: FastifyRequest;
  profileId: string;
  message: JsonRpcMessage;
  requestId: string | number | undefined;
}): Promise<JsonRpcMessage | undefined> {
  const { request, profileId, message, requestId } = params;

  const response = await fetch(gatewayLoopbackUrl(request, profileId), {
    method: "POST",
    headers: forwardedHeaders(request),
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
  });

  // A notification or a client response gets 202 and no body: nothing to relay.
  if (response.status === 202 || response.status === 204) {
    await response.body?.cancel();
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    await response.body?.cancel();
    throw new Error(
      `Unexpected gateway content type: ${contentType || "none"}`,
    );
  }

  const answer: unknown = await response.json();
  if (!isRecord(answer)) return;
  if (answer.id !== null && answer.id !== undefined) return answer;
  // A route-level rejection (401, 400, ...) carries `id: null`. Give it the
  // request's id so the client's pending call fails now, with the reason,
  // instead of at its timeout.
  return requestId === undefined ? undefined : { ...answer, id: requestId };
}

function gatewayLoopbackUrl(
  request: FastifyRequest,
  profileId: string,
): string {
  // The listener serving this request, which in tests is an ephemeral port.
  const address = request.server.server.address();
  const port =
    typeof address === "object" && address ? address.port : config.api.port;
  return `http://${LOOPBACK_HOST}:${port}${config.mcpGateway.endpoint}/${profileId}`;
}

/**
 * The client's own headers travel with the replay — the credential, the
 * negotiated protocol version, and any header the gateway is configured to
 * pass through — minus hop-by-hop ones and those the replay sets itself.
 */
function forwardedHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HEADERS_NOT_FORWARDED.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  // The SDK transport insists on both, whatever the legacy client sent.
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  return headers;
}

function requestPath(request: FastifyRequest): string {
  return (request.url.split("?")[0] ?? "").replace(/\/+$/, "");
}

function readRequestId(message: JsonRpcMessage): string | number | undefined {
  const { id } = message;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function isRecord(value: unknown): value is JsonRpcMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
