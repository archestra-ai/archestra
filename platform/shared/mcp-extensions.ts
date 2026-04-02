/**
 * Official MCP extension identifiers and initialize capability payloads.
 * Spec reference:
 * https://modelcontextprotocol.io/extensions/overview#negotiation
 * https://modelcontextprotocol.io/extensions/client-matrix#extension-overview
 * TypeScript SDK typing gap:
 * https://github.com/modelcontextprotocol/typescript-sdk/issues/1063
 */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_ENTERPRISE_AUTH_EXTENSION_ID =
  "io.modelcontextprotocol/enterprise-managed-authorization";

export const MCP_APPS_CLIENT_EXTENSION_CAPABILITIES = {
  [MCP_APPS_EXTENSION_ID]: {
    mimeTypes: ["text/html;profile=mcp-app"] as const,
  },
} as const;

export const MCP_APPS_SERVER_EXTENSION_CAPABILITIES = {
  [MCP_APPS_EXTENSION_ID]: {},
} as const;

export const MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES = {
  [MCP_ENTERPRISE_AUTH_EXTENSION_ID]: {},
} as const;
