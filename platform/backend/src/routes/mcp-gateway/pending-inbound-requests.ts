import { randomUUID } from "node:crypto";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import logger from "@/logging";

const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_REQUESTS = 256;
const MAX_PENDING_REQUESTS_PER_CALLER = 16;

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

/**
 * Maps outbound server-initiated requests (elicitation, sampling) to active transports.
 * In stateless mode, clients answer server-initiated requests with a separate POST.
 * Because each POST creates a fresh server, this registry routes the answer
 * to the original transport waiting for it.
 *
 * Each request receives a unique wire ID to prevent collisions across concurrent calls.
 * Answers are accepted only from the caller that received the request on this gateway.
 *
 * This registry is in-memory because it holds references to live transports.
 */
class PendingInboundRequests {
  private readonly entries = new Map<string, PendingInbound>();

  /**
   * Registers an outbound request and returns the id to send it under.
   *
   * Refuses admission when either limit is full. A request is never evicted to
   * make room for another caller: rejecting `transport.send()` instead lets the
   * Server fail the request it was trying to issue.
   */
  register(params: {
    id: string | number;
    transport: StreamableHTTPServerTransport;
    agentId: string;
    caller: string;
  }): string {
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

  /** Forget a request the Server cancelled or stopped waiting on. */
  forget(params: { wireId: string }): void {
    this.remove(params.wireId);
  }

  /** Forget every request that depended on a transport that has closed. */
  forgetTransport(params: { transport: StreamableHTTPServerTransport }): void {
    for (const [wireId, entry] of this.entries) {
      if (entry.transport === params.transport) {
        this.remove(wireId);
      }
    }
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
  }
}

export const pendingInboundRequests = new PendingInboundRequests();
