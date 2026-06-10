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

export const MCP_ELICITATION_CLIENT_CAPABILITY = {
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
  handler: McpElicitationHandler = defaultMcpElicitationHandler,
): void {
  client.setRequestHandler(ElicitRequestSchema, handler);
  client.setNotificationHandler(
    ElicitationCompleteNotificationSchema,
    async ({ params }) => {
      logger.info(
        { elicitationId: params.elicitationId },
        "MCP URL elicitation completed",
      );
    },
  );
}

// =============================================================================
// Internal helpers
// =============================================================================

function defaultMcpElicitationHandler(request: ElicitRequest): ElicitResult {
  logger.info(
    {
      mode: request.params.mode ?? "form",
      elicitationId:
        request.params.mode === "url" ? request.params.elicitationId : null,
    },
    "Declining MCP elicitation request because no interactive handler is available",
  );

  return { action: "decline" };
}
