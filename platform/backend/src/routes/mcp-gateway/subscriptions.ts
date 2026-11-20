import { createHash } from "node:crypto";
import { once } from "node:events";
import { type IncomingMessage, request as requestHttp } from "node:http";
import { createInterface } from "node:readline";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { registerShutdownStream } from "@/server/llm-proxy-drain";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
import {
  type CatalogAccessCaller,
  filterToolsByCallerCatalogAccess,
} from "@/services/caller-catalog-access";
import { clientDisconnectSignal } from "@/utils/client-disconnect-signal";
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
export async function toolsListFingerprint(
  agentId: string,
  caller?: CatalogAccessCaller,
): Promise<string> {
  const { tools: agentTools } =
    await agentToolExclusionsService.getFilteredMcpToolsByAgent(agentId);
  const tools = caller
    ? await filterToolsByCallerCatalogAccess(agentTools, caller)
    : agentTools;
  const names = tools.map((tool) => tool.name).sort();
  return createHash("sha256").update(names.join("\n")).digest("base64url");
}

/**
 * Run a `subscriptions/listen` stream over the hijacked reply until the client
 * disconnects. A positive maximum duration, off by default, also ends it.
 *
 * Wire behavior, in spec order: the acknowledgment is the FIRST message and
 * carries the subscription id (the JSON-RPC id of the listen request); every
 * later notification carries the same id in `_meta`; a server-initiated end
 * sends the JSON-RPC response for the listen request before closing. A client
 * may treat that as a clean end and open another listen. Reconnection requires
 * client support; the protocol does not require it. If the client does not
 * listen again, tool-list change notifications stop until it does. The
 * response ends only this stream. In-flight `tools/call` requests, including
 * an input request the client is still fulfilling, are separate and are not
 * cancelled.
 *
 * A positive duration is a limited mitigation, not a universal fix. It must
 * stay below the HTTP proxy's hard maximum request duration, which this
 * process does not know. Heartbeats reset idle timeouts only. A proxy reset
 * can fail an open form; a clean end does not guarantee the client will
 * listen again, and some clients stop after repeated ends.
 */
export async function runSubscriptionStream(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  agentId: string;
  subscriptionId: string | number;
  requested: SubscriptionFilter;
  /** Who is listening: their tool list is narrowed to catalogs they can see. */
  caller?: CatalogAccessCaller;
  nativeSocket?: string;
  onAcknowledged?: (honored: SubscriptionFilter) => void;
  /** Injectable for tests; defaults to the real fingerprint. */
  computeFingerprint?: () => Promise<string>;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  /**
   * Injectable for tests. 0, the default, does not end the stream. A positive
   * value must be below the proxy's hard request duration.
   */
  maxDurationMs?: number;
}): Promise<void> {
  const {
    reply,
    agentId,
    subscriptionId,
    requested,
    caller,
    computeFingerprint = () => toolsListFingerprint(agentId, caller),
    pollIntervalMs = SUBSCRIPTION_POLL_INTERVAL_MS,
    heartbeatMs = SUBSCRIPTION_HEARTBEAT_MS,
    maxDurationMs = config.mcpGateway.subscriptionMaxDurationMs,
  } = params;

  const honored = acknowledgedFilter(requested);
  if (params.nativeSocket) {
    return runNativeSubscription({
      ...params,
      socketPath: params.nativeSocket,
      computeFingerprint,
      pollIntervalMs,
      heartbeatMs,
      maxDurationMs,
      honored,
    });
  }

  startReply(reply);

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
  params.onAcknowledged?.(honored);

  registerShutdownStream(params.request, reply, endGracefully);

  const timers: NodeJS.Timeout[] = [];
  let closed = false;

  const clearTimers = (): void => {
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    timers.length = 0;
  };

  const stop = (): void => {
    if (closed) return;
    closed = true;
    clearTimers();
  };

  // The response, not the request. For a long-lived POST the request can
  // finish when its body has been read while the stream is still open.
  reply.raw.on("close", () => {
    const alreadyClosed = closed;
    stop();
    if (!alreadyClosed) {
      logger.debug(
        { agentId, subscriptionId },
        "MCP subscription stream closed",
      );
    }
  });

  timers.push(
    setInterval(() => {
      if (!closed) reply.raw.write(`: keep-alive\n\n`);
    }, heartbeatMs),
  );

  if (maxDurationMs > 0) {
    timers.push(
      setTimeout(() => {
        endGracefully();
      }, maxDurationMs),
    );
  }

  if (honored.toolsListChanged) {
    let lastFingerprint: string;
    try {
      lastFingerprint = await computeFingerprint();
      if (closed) return;
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
          // The await can outlive rotation or disconnect. Do not write a
          // notification after the terminal result or onto a closed socket.
          if (closed || fingerprint === lastFingerprint) return;
          lastFingerprint = fingerprint;
          if (closed) return;
          send({
            jsonrpc: "2.0",
            method: TOOLS_LIST_CHANGED_METHOD,
            params: {
              _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId },
            },
          });
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
    // Stop timers before the terminal frame so a heartbeat cannot follow it.
    stop();
    // The JSON-RPC response to the original listen request signals graceful
    // closure, as opposed to an abrupt transport drop. A client may listen
    // again; that is not guaranteed. Other in-flight requests are untouched.
    send({
      jsonrpc: "2.0",
      id: subscriptionId,
      result: {
        resultType: COMPLETE_RESULT_TYPE,
        _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId },
      },
    });
    reply.raw.end();
  }
}

const nativeFrame = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sse"), value: z.string() }),
  z.object({ kind: z.literal("poll") }),
]);

async function runNativeSubscription(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  socketPath: string;
  subscriptionId: string | number;
  honored: SubscriptionFilter;
  computeFingerprint: () => Promise<string>;
  pollIntervalMs: number;
  heartbeatMs: number;
  maxDurationMs: number;
  onAcknowledged?: (honored: SubscriptionFilter) => void;
}): Promise<void> {
  const { request, reply, honored, subscriptionId } = params;
  const signal = clientDisconnectSignal({ request, reply });
  const relay = requestHttp({
    socketPath: params.socketPath,
    path: "/internal/v1/mcp/subscription",
    method: "POST",
    agent: false,
    signal,
    headers: { "content-type": "application/x-ndjson" },
  });
  const send = (value: object) => {
    if (!relay.destroyed && !relay.writableEnded)
      relay.write(`${JSON.stringify(value)}\n`);
  };
  let upstream: IncomingMessage | undefined;
  relay.on("error", (error) => upstream?.destroy(error));
  const open = once(relay, "response", { signal });
  const deadline = setTimeout(
    () => relay.destroy(new Error("Rust subscription header timeout")),
    10_000,
  );
  let acknowledged = false;
  try {
    send({
      subscriptionId,
      toolsListChanged: honored.toolsListChanged === true,
      pollIntervalMs: params.pollIntervalMs,
      heartbeatMs: params.heartbeatMs,
      maxDurationMs: params.maxDurationMs,
    });
    [upstream] = (await open) as [IncomingMessage];
    clearTimeout(deadline);
    if (upstream.statusCode !== 200)
      throw new Error("Rust subscription rejected the request");
    const lines = createInterface({ input: upstream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (signal.aborted) break;
        const frame = nativeFrame.parse(JSON.parse(line));
        if (frame.kind === "poll") {
          void params.computeFingerprint().then(
            (value) => send({ kind: "fingerprint", value }),
            () => send({ kind: "failed" }),
          );
          continue;
        }
        if (!acknowledged) {
          startReply(reply);
          acknowledged = true;
          registerShutdownStream(request, reply, () => send({ kind: "end" }));
          params.onAcknowledged?.(honored);
        }
        if (!reply.raw.write(frame.value))
          await once(reply.raw, "drain", { signal });
      }
    } finally {
      lines.close();
    }
    if (!acknowledged && !signal.aborted)
      throw new Error("Rust subscription did not acknowledge");
    if (acknowledged && !reply.raw.destroyed) reply.raw.end();
  } catch (err) {
    if (signal.aborted) return;
    logger.warn({ err }, "Rust MCP subscription relay failed");
    if (acknowledged) reply.raw.destroy();
    else {
      reply.status(502).send({
        jsonrpc: "2.0",
        id: subscriptionId,
        error: { code: -32603, message: "MCP subscription unavailable" },
      });
    }
  } finally {
    clearTimeout(deadline);
    relay.destroy();
  }
}

function startReply(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    [MCP_PROTOCOL_VERSION_HEADER]: STATELESS_MCP_PROTOCOL_REVISION,
  });
}
