import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

/**
 * The MCP TypeScript SDK does not yet model `capabilities.extensions` on the
 * client/server constructor options, even though the initialize handshake
 * needs it. Track upstream here:
 * https://github.com/modelcontextprotocol/typescript-sdk/issues/1063
 */
export type ClientCapabilitiesWithExtensions = ClientCapabilities & {
  extensions?: Record<string, unknown>;
};

export type McpServerCapabilitiesWithExtensions = NonNullable<
  ConstructorParameters<typeof McpServer>[1]
>["capabilities"] & {
  extensions?: Record<string, unknown>;
};
