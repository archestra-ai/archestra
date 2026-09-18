import { randomUUID } from "node:crypto";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import logger from "@/logging";

const TTL_MS = 10 * 60 * 1000;

type PendingInbound = {
  transport: StreamableHTTPServerTransport;
  /** The id the Server issued; the answer is fed back to it under this id. */
  id: string | number;
  agentId: string;
  /** The caller that was asked; only it may answer. */
  caller: string;
  createdAt: number;
};

/**
 * Server-initiated requests (elicitation/create, sampling, ...) sent mid-call
 * are answered by the client with a separate POST. The gateway builds a fresh
 * Server per POST (stateless mode), so that answer would land on a Server
 * that has no pending request with the elicitation id. This registry maps the
 * id of every outbound server-initiated request to the transport that sent
 * it, so the answer POST can be fed back into the Server still waiting on it.
 *
 * Every fresh Server numbers its requests from 0, so the request goes out
 * under a random wire id instead: concurrent calls never collide, and an
 * answer is accepted only from the caller that was asked, on the gateway that
 * asked it.
 *
 * In-memory on purpose: the value is a live transport. Cross-replica
 * elicitation answers are not routed; that requires a real session.
 */
class PendingInboundRequests {
  private readonly entries = new Map<string, PendingInbound>();

  /** Registers an outbound request and returns the id to send it under. */
  register(params: {
    id: string | number;
    transport: StreamableHTTPServerTransport;
    agentId: string;
    caller: string;
  }): string {
    this.prune();
    const wireId = `archestra-${randomUUID()}`;
    this.entries.set(wireId, { ...params, createdAt: Date.now() });
    return wireId;
  }

  /** The wire id a transport's pending request went out under, if any. */
  wireIdOf(params: {
    transport: StreamableHTTPServerTransport;
    id: string | number;
  }): string | undefined {
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
    if (entry.agentId !== params.agentId || entry.caller !== params.caller) {
      logger.warn(
        { agentId: params.agentId },
        "Ignored an answer to a server-initiated request asked of another caller",
      );
      return undefined;
    }
    this.entries.delete(key);
    if (Date.now() - entry.createdAt > TTL_MS) {
      logger.warn(
        { agentId: entry.agentId },
        "Client answer arrived after the pending server-initiated request expired",
      );
      return undefined;
    }
    return entry;
  }

  /** Forget a request the Server cancelled or stopped waiting on. */
  forget(params: { wireId: string }): void {
    this.entries.delete(params.wireId);
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [key, entry] of this.entries) {
      if (entry.createdAt < cutoff) {
        this.entries.delete(key);
      }
    }
  }
}

export const pendingInboundRequests = new PendingInboundRequests();
