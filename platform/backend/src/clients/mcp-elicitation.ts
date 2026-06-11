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
  client.setRequestHandler(ElicitRequestSchema, handler);
  client.setNotificationHandler(
    ElicitationCompleteNotificationSchema,
    async ({ params }) => {
      // The URL flow is completed out-of-band by the server/client pair. The
      // chat bridge has no local resource to release here, so we only log it.
      logger.info(
        { elicitationId: params.elicitationId },
        "MCP URL elicitation completed",
      );
    },
  );
}
