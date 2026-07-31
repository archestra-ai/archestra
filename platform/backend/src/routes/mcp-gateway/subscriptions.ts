import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

import logger from "@/logging";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import {
  COMPLETE_RESULT_TYPE,
  MCP_PROTOCOL_VERSION_HEADER,
  STATELESS_MCP_PROTOCOL_REVISION,
} from "./protocol";

/**
 * `subscriptions/listen` (2026-07-28, SEP-2575) — the long-lived notification
 * stream that replaces `resources/subscribe` and the HTTP GET endpoint.
 *
 * The gateway honors `toolsListChanged` only. A gateway's tool list is computed
 * from the local database, so change detection is a cheap fingerprint poll.
 * The prompt and resource lists are aggregated from upstream servers, so
 * honoring their change types would mean polling every upstream on every tick
 * for every open stream — the spec anticipates partial support, and the
 * acknowledgment carries exactly the subset the server agreed to honor, so a
 * client learns up front what it will and will not receive.
 */

export const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";
export const SUBSCRIPTION_ID_META_KEY =
  "io.modelcontextprotocol/subscriptionId";
export const SUBSCRIPTION_ACK_METHOD =
  "notifications/subscriptions/acknowledged";
export const TOOLS_LIST_CHANGED_METHOD = "notifications/tools/list_changed";

/**
 * How often an open stream re-checks the tool list, and how often it emits an
 * SSE comment so idle-connection timeouts along the path don't kill it.
 */
export const SUBSCRIPTION_POLL_INTERVAL_MS = 20_000;
export const SUBSCRIPTION_HEARTBEAT_MS = 25_000;

export interface SubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}

export function isSubscriptionsListenRequest(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: unknown }).method === SUBSCRIPTIONS_LISTEN_METHOD
  );
}

export function parseSubscriptionFilter(body: unknown): SubscriptionFilter {
  if (typeof body !== "object" || body === null) return {};
  const params = (body as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return {};
  const notifications = (params as { notifications?: unknown }).notifications;
  if (typeof notifications !== "object" || notifications === null) return {};

  const source = notifications as Record<string, unknown>;
  return {
    ...(source.toolsListChanged === true && { toolsListChanged: true }),
    ...(source.promptsListChanged === true && { promptsListChanged: true }),
    ...(source.resourcesListChanged === true && {
      resourcesListChanged: true,
    }),
    ...(Array.isArray(source.resourceSubscriptions) && {
      resourceSubscriptions: source.resourceSubscriptions.filter(
        (uri): uri is string => typeof uri === "string",
      ),
    }),
  };
}

/**
 * The subset of a requested filter the gateway honors. The spec has the
 * acknowledgment carry exactly this, with unsupported types omitted, so the
 * client knows not to wait for them.
 */
export function acknowledgedFilter(
  requested: SubscriptionFilter,
): SubscriptionFilter {
  return requested.toolsListChanged ? { toolsListChanged: true } : {};
}

/**
 * Fingerprint of the tool list a caller would see.
 *
 * A conservative change signal rather than a byte-exact one: it hashes the
 * sorted names from the same per-agent filtered set `tools/list` starts from.
 * It can over-fire (a change that doesn't alter the final advertised list) —
 * safe, the client refetches and sees the same list — and it can miss edits
 * that change a tool's description but not the set. Membership is what
 * clients key caching on, so that is the signal worth polling cheaply.
 */
export async function toolsListFingerprint(agentId: string): Promise<string> {
  const { tools } =
    await agentToolExclusionsService.getFilteredMcpToolsByAgent(agentId);
  const names = tools.map((tool) => tool.name).sort();
  return createHash("sha256").update(names.join("\n")).digest("base64url");
}

/**
 * Run a `subscriptions/listen` stream over the hijacked reply until the client
 * closes it.
 *
 * Wire behavior, in spec order: the acknowledgment is the FIRST message and
 * carries the subscription id (the JSON-RPC id of the listen request); every
 * later notification carries the same id in `_meta`; a server-initiated end
 * sends the empty JSON-RPC response for the listen request before closing, so
 * the client can tell graceful closure from a dropped transport.
 */
export async function runSubscriptionStream(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  agentId: string;
  subscriptionId: string | number;
  requested: SubscriptionFilter;
  /** Injectable for tests; defaults to the real fingerprint. */
  computeFingerprint?: () => Promise<string>;
  pollIntervalMs?: number;
  heartbeatMs?: number;
}): Promise<void> {
  const {
    request,
    reply,
    agentId,
    subscriptionId,
    requested,
    computeFingerprint = () => toolsListFingerprint(agentId),
    pollIntervalMs = SUBSCRIPTION_POLL_INTERVAL_MS,
    heartbeatMs = SUBSCRIPTION_HEARTBEAT_MS,
  } = params;

  const honored = acknowledgedFilter(requested);

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    [MCP_PROTOCOL_VERSION_HEADER]: STATELESS_MCP_PROTOCOL_REVISION,
  });

  const send = (message: Record<string, unknown>): void => {
    reply.raw.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  };

  // Acknowledgment first — nothing may precede it on this subscription.
  send({
    jsonrpc: "2.0",
    method: SUBSCRIPTION_ACK_METHOD,
    params: {
      _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId },
      notifications: honored,
    },
  });

  const timers: NodeJS.Timeout[] = [];
  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
  };

  request.raw.on("close", () => {
    cleanup();
    logger.debug({ agentId, subscriptionId }, "MCP subscription stream closed");
  });

  timers.push(
    setInterval(() => {
      if (!closed) reply.raw.write(`: keep-alive\n\n`);
    }, heartbeatMs),
  );

  if (honored.toolsListChanged) {
    let lastFingerprint: string;
    try {
      lastFingerprint = await computeFingerprint();
    } catch (error) {
      // Cannot establish a baseline: end gracefully rather than stream
      // notifications against an unknown starting state.
      logger.warn(
        { agentId, subscriptionId, error },
        "MCP subscription could not compute initial tools fingerprint",
      );
      endGracefully();
      return;
    }

    timers.push(
      setInterval(async () => {
        if (closed) return;
        try {
          const fingerprint = await computeFingerprint();
          if (fingerprint !== lastFingerprint) {
            lastFingerprint = fingerprint;
            send({
              jsonrpc: "2.0",
              method: TOOLS_LIST_CHANGED_METHOD,
              params: {
                _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId },
              },
            });
          }
        } catch (error) {
          // A transient failure must not kill a long-lived stream; the next
          // tick retries against the same baseline.
          logger.debug(
            { agentId, subscriptionId, error },
            "MCP subscription fingerprint poll failed; will retry",
          );
        }
      }, pollIntervalMs),
    );
  }

  function endGracefully(): void {
    if (closed) return;
    // The empty JSON-RPC response to the original listen request signals
    // graceful closure, as opposed to an abrupt transport drop.
    send({
      jsonrpc: "2.0",
      id: subscriptionId,
      result: {
        resultType: COMPLETE_RESULT_TYPE,
        _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId },
      },
    });
    cleanup();
    reply.raw.end();
  }
}
