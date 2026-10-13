import { randomUUID } from "node:crypto";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import logger from "@/logging";

const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_REQUESTS = 256;
const MAX_PENDING_REQUESTS_PER_CALLER = 16;
/** How often a replica collects answers another replica received for it. */
const PARKED_MESSAGE_POLL_MS = 1_000;

type PendingInbound = {
  transport: StreamableHTTPServerTransport;
  /** The id the Server issued; the answer is fed back to it under this id. */
  id: string | number;
  agentId: string;
  /** The caller that was asked; only it may answer. */
  caller: string;
  createdAt: number;
  expiryTimer?: NodeJS.Timeout;
};

/** Who was asked a pending request, as every replica can read it. */
export type PendingRequestRecord = { agentId: string; caller: string };

/** A client message one replica received for a request another one holds. */
export type ParkedClientMessage = PendingRequestRecord & {
  message: Record<string, unknown>;
};

/**
 * Storage shared by every replica. A client answers a server-initiated
 * request with a separate POST, and the load balancer may send that POST to a
 * replica other than the one waiting on the answer.
 */
export interface SharedPendingRequests {
  remember(params: {
    wireId: string;
    record: PendingRequestRecord;
    ttlMs: number;
  }): Promise<void>;
  lookup(wireId: string): Promise<PendingRequestRecord | undefined>;
  park(params: {
    wireId: string;
    parked: ParkedClientMessage;
    ttlMs: number;
  }): Promise<void>;
  take(
    wireIds: string[],
  ): Promise<Array<{ wireId: string; parked: ParkedClientMessage }>>;
  forget(wireId: string): Promise<void>;
}

/**
 * Maps outbound server-initiated requests (elicitation, sampling) to active transports.
 * In stateless mode, clients answer server-initiated requests with a separate POST.
 * Because each POST creates a fresh server, this registry routes the answer
 * to the original transport waiting for it.
 *
 * Each request receives a unique wire ID to prevent collisions across concurrent calls.
 * Answers are accepted only from the caller that received the request on this gateway.
 *
 * The registry is in-memory because it holds references to live transports.
 * With shared storage, an answer that reaches another replica is parked there
 * and collected by the replica that holds the transport.
 */
export class PendingInboundRequests {
  private readonly entries = new Map<string, PendingInbound>();
  private readonly shared: SharedPendingRequests | undefined;
  private readonly pollMs: number;
  private poller: NodeJS.Timeout | undefined;
  private collecting = false;

  constructor(
    params: { shared?: SharedPendingRequests; pollMs?: number } = {},
  ) {
    this.shared = params.shared;
    this.pollMs = params.pollMs ?? PARKED_MESSAGE_POLL_MS;
  }

  /**
   * Registers an outbound request and returns the id to send it under.
   *
   * Refuses admission when either limit is full. A request is never evicted to
   * make room for another caller: rejecting `transport.send()` instead lets the
   * Server fail the request it was trying to issue.
   */
  async register(params: {
    id: string | number;
    transport: StreamableHTTPServerTransport;
    agentId: string;
    caller: string;
  }): Promise<string> {
    this.prune();
    if (this.entries.size >= MAX_PENDING_REQUESTS) {
      throw new Error("Too many pending server-initiated requests");
    }
    if (
      this.pendingForCaller(params.caller) >= MAX_PENDING_REQUESTS_PER_CALLER
    ) {
      throw new Error(
        "Too many pending server-initiated requests for this caller",
      );
    }

    const wireId = `archestra-${randomUUID()}`;
    const entry: PendingInbound = { ...params, createdAt: Date.now() };
    this.entries.set(wireId, entry);
    entry.expiryTimer = setTimeout(() => {
      if (this.entries.get(wireId) === entry) {
        this.remove(wireId);
      }
    }, TTL_MS);
    entry.expiryTimer.unref();
    if (this.shared) {
      try {
        await this.shared.remember({
          wireId,
          record: { agentId: params.agentId, caller: params.caller },
          ttlMs: TTL_MS,
        });
        this.startCollecting();
      } catch (error) {
        // The request still works when its answer reaches this replica.
        logger.warn(
          { agentId: params.agentId, error },
          "Could not share a pending server-initiated request with other replicas",
        );
      }
    }
    return wireId;
  }

  /** The wire id a transport's pending request went out under, if any. */
  wireIdOf(params: {
    transport: StreamableHTTPServerTransport;
    id: string | number;
  }): string | undefined {
    this.prune();
    for (const [wireId, entry] of this.entries) {
      if (entry.transport === params.transport && entry.id === params.id) {
        return wireId;
      }
    }
    return undefined;
  }

  /**
   * Remove and return the pending entry for this wire id, if it is still
   * fresh and the answer comes from the caller that was asked. Consume-once:
   * a retried answer POST finds nothing and follows the ordinary path, which
   * ignores it. Another caller's answer leaves the entry in place.
   */
  consume(params: {
    wireId: string | number;
    agentId: string;
    caller: string;
  }): PendingInbound | undefined {
    const key = String(params.wireId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.remove(key);
      logger.warn(
        { agentId: entry.agentId },
        "Client answer arrived after the pending server-initiated request expired",
      );
      return undefined;
    }
    if (entry.agentId !== params.agentId || entry.caller !== params.caller) {
      logger.warn(
        { agentId: params.agentId },
        "Ignored an answer to a server-initiated request asked of another caller",
      );
      return undefined;
    }
    this.remove(key);
    return entry;
  }

  /**
   * Keep a client message for the replica that sent the request it answers.
   * Accepted only when no request with this wire id waits here, some replica
   * recorded one, and the message comes from the caller that was asked.
   */
  async parkForOtherReplica(params: {
    wireId: string | number;
    agentId: string;
    caller: string;
    message: Record<string, unknown>;
  }): Promise<boolean> {
    const wireId = String(params.wireId);
    if (!this.shared || this.entries.has(wireId)) return false;
    const record = await this.shared.lookup(wireId);
    if (!record) return false;
    if (record.agentId !== params.agentId || record.caller !== params.caller) {
      logger.warn(
        { agentId: params.agentId },
        "Ignored an answer to a server-initiated request asked of another caller",
      );
      return false;
    }
    await this.shared.park({
      wireId,
      parked: {
        agentId: params.agentId,
        caller: params.caller,
        message: params.message,
      },
      ttlMs: TTL_MS,
    });
    return true;
  }

  /** Forget a request the Server cancelled or stopped waiting on. */
  forget(params: { wireId: string }): void {
    this.remove(params.wireId);
  }

  /**
   * Forget every request that depended on a transport that has closed.
   * The registry holds the live transport the answer POST writes back to; a
   * closed transport cannot deliver that answer, so TTL cannot keep it alive.
   */
  forgetTransport(params: { transport: StreamableHTTPServerTransport }): void {
    for (const [wireId, entry] of this.entries) {
      if (entry.transport === params.transport) {
        logger.warn(
          { agentId: entry.agentId },
          "Dropping pending server-initiated request because its transport closed",
        );
        this.remove(wireId);
      }
    }
  }

  /** Stop collecting answers parked by other replicas. */
  close(): void {
    this.stopCollecting();
  }

  private startCollecting(): void {
    if (this.poller) return;
    this.poller = setInterval(() => this.collectParked(), this.pollMs);
    // Never keep the process alive just to poll.
    this.poller.unref();
  }

  private stopCollecting(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
  }

  /** One tick: hand each transport the answers other replicas parked for it. */
  private collectParked(): void {
    this.prune();
    if (!this.shared || this.entries.size === 0) {
      this.stopCollecting();
      return;
    }
    if (this.collecting) return;
    this.collecting = true;
    this.shared
      .take([...this.entries.keys()])
      .then((parked) => {
        for (const { wireId, parked: answer } of parked) {
          const entry = this.consume({
            wireId,
            agentId: answer.agentId,
            caller: answer.caller,
          });
          if (entry) deliverClientMessage({ entry, message: answer.message });
        }
      })
      .catch((error) => {
        // The next tick reads again.
        logger.debug({ error }, "Collecting parked client answers failed");
      })
      .finally(() => {
        this.collecting = false;
      });
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) {
        this.remove(key);
      }
    }
  }

  private pendingForCaller(caller: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.caller === caller) count += 1;
    }
    return count;
  }

  private isExpired(entry: PendingInbound): boolean {
    return Date.now() - entry.createdAt >= TTL_MS;
  }

  private remove(wireId: string): void {
    const entry = this.entries.get(wireId);
    if (!entry) return;
    this.entries.delete(wireId);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    this.shared?.forget(wireId).catch((error) => {
      logger.debug({ error }, "Could not forget a shared pending request");
    });
  }
}

/**
 * Feed a client's answer or cancellation to the Server that sent the request,
 * under the id that Server issued.
 */
export function deliverClientMessage(params: {
  entry: Pick<PendingInbound, "transport" | "id">;
  message: Record<string, unknown>;
}): void {
  const { entry, message } = params;
  const cancellation =
    message.method === "notifications/cancelled" &&
    typeof message.params === "object" &&
    message.params !== null;
  entry.transport.onmessage?.(
    (cancellation
      ? {
          ...message,
          params: {
            ...(message.params as Record<string, unknown>),
            requestId: entry.id,
          },
        }
      : { ...message, id: entry.id }) as unknown as JSONRPCMessage,
  );
}
