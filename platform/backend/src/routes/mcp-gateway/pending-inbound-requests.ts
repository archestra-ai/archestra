import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import logger from "@/logging";

const TTL_MS = 10 * 60 * 1000;

type PendingInbound = {
  transport: StreamableHTTPServerTransport;
  agentId: string;
  createdAt: number;
};

/**
 * Server-initiated requests (elicitation/create, sampling, ...) sent mid-call
 * are answered by the client with a separate POST. The gateway builds a fresh
 * Server per POST (stateless mode), so that answer would land on a Server
 * that has no pending request with the elicitation id. This registry maps the
 * JSON-RPC id of every outbound server-initiated request to the transport
 * that sent it, so the answer POST can be fed back into the Server still
 * waiting on it.
 *
 * In-memory on purpose: the value is a live transport. Cross-replica
 * elicitation answers are not routed; that requires a real session.
 */
class PendingInboundRequests {
  private readonly entries = new Map<string, PendingInbound>();

  register(params: {
    id: string | number;
    transport: StreamableHTTPServerTransport;
    agentId: string;
  }): void {
    const { id, transport, agentId } = params;
    this.prune();
    this.entries.set(String(id), { transport, agentId, createdAt: Date.now() });
  }

  /**
   * Remove and return the pending entry for this id, if it is still fresh.
   * Consume-once: a retried answer POST finds nothing and follows the
   * ordinary path, which ignores it.
   */
  consume(params: { id: string | number }): PendingInbound | undefined {
    const { id } = params;
    const entry = this.entries.get(String(id));
    this.entries.delete(String(id));
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > TTL_MS) {
      logger.warn(
        { agentId: entry.agentId },
        "Client answer arrived after the pending server-initiated request expired",
      );
      return undefined;
    }
    return entry;
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
