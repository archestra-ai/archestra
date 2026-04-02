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
