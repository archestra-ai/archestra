import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type ClientNotification,
  type ClientRequest,
  ElicitationCompleteNotificationSchema,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

import logger from "@/logging";
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

export function configureMcpElicitation(
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
