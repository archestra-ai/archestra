import { AsyncLocalStorage } from "node:async_hooks";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type ClientNotification,
  type ClientRequest,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ClientCapabilitiesWithExtensions } from "@/types/mcp-capabilities";

// =============================================================================
// MCP elicitation support
// =============================================================================

const MCP_ELICITATION_CLIENT_CAPABILITY = {
  form: { applyDefaults: true },
  url: {},
} as const;

export type McpElicitationHandler = (
  request: ElicitRequest,
  extra: RequestHandlerExtra<ClientRequest, ClientNotification>,
) => ElicitResult | Promise<ElicitResult>;

export function withMcpElicitationCapability(
  capabilities: ClientCapabilitiesWithExtensions,
): ClientCapabilitiesWithExtensions {
  return {
    ...capabilities,
    elicitation: MCP_ELICITATION_CLIENT_CAPABILITY,
  };
}

/**
 * Routes a server's questions to the tool call that caused them, so the calls
 * on one connection can run at the same time.
 *
 * The SDK keeps one elicitation handler per client, but each tool call brings
 * its own: the handler names the call its question belongs to. A handler
 * installed per call would be replaced by the next call on the connection, so
 * the client gets this router once, and every call registers its handler for
 * as long as its request runs.
 *
 * A server sends a question on the response stream of the request that
 * caused it, as the specification asks. The SDK reads that stream in the
 * async context of the request, so the question arrives in the context of
 * its own call and reaches that call's handler. A question that arrives
 * outside any call's context (a stdio server, or one that uses the standalone
 * stream) cannot be tied to a call: it goes to the oldest call still in
 * flight on the connection. With one call in flight that is exact. With
 * several it is a guess, so the caller lets calls share a connection only
 * where a wrong guess stays inside one conversation.
 */
export class McpElicitationRouter {
  private scope = new AsyncLocalStorage<ElicitationLease>();
  private leases = new WeakMap<Client, Set<ElicitationLease>>();
  // A question can arrive after its call returned: it keeps reaching the
  // connection's latest call, as it did when each call installed its handler.
  private latestHandler = new WeakMap<Client, McpElicitationHandler>();

  /** Installs the router on a client. Safe to repeat on a reused client. */
  attach(client: Client): void {
    configureMcpElicitation(client, (request, extra) =>
      this.route(client, request, extra),
    );
  }

  /**
   * Runs one request of a tool call. `handler` answers the questions the
   * server asks until the request settles.
   */
  async run<T>(
    client: Client,
    handler: McpElicitationHandler,
    request: () => Promise<T>,
  ): Promise<T> {
    const lease: ElicitationLease = { handler, active: true };
    const leases = this.leases.get(client) ?? new Set<ElicitationLease>();
    this.leases.set(client, leases);
    leases.add(lease);
    this.latestHandler.set(client, handler);
    try {
      return await this.scope.run(lease, request);
    } finally {
      lease.active = false;
      leases.delete(lease);
    }
  }

  private route(
    client: Client,
    request: ElicitRequest,
    extra: RequestHandlerExtra<ClientRequest, ClientNotification>,
  ): ElicitResult | Promise<ElicitResult> {
    const scoped = this.scope.getStore();
    // A settled call's context outlives it (the standalone stream keeps the
    // context it was opened in), so only a call still in flight counts.
    const [oldest] = this.leases.get(client) ?? [];
    const handler =
      (scoped?.active ? scoped.handler : oldest?.handler) ??
      this.latestHandler.get(client);
    if (!handler) {
      return { action: "cancel" };
    }
    return handler(request, extra);
  }
}

type ElicitationLease = { handler: McpElicitationHandler; active: boolean };

function configureMcpElicitation(
  client: Client,
  handler: McpElicitationHandler,
): void {
  // `notifications/elicitation/complete` is removed in 2026-07-28: under MRTR a
  // client learns an out-of-band interaction's outcome by retrying the original
  // request, so a server-initiated completion signal no longer fits. The
  // handler only logged, so nothing is lost by not registering it — and a
  // 2025-11-25 server that still sends one is simply ignored.
  client.setRequestHandler(ElicitRequestSchema, handler);
}
