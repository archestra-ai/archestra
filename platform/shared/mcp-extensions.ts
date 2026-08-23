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
export const MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID =
  "io.modelcontextprotocol/oauth-client-credentials";
export const MCP_SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

export const MCP_APPS_CLIENT_EXTENSION_CAPABILITIES = {
  [MCP_APPS_EXTENSION_ID]: {
    mimeTypes: ["text/html;profile=mcp-app"] as const,
  },
} as const;

export const MCP_APPS_SERVER_EXTENSION_CAPABILITIES = {
  [MCP_APPS_EXTENSION_ID]: {},
} as const;

export const MCP_SKILLS_CLIENT_EXTENSION_CAPABILITIES = {
  [MCP_SKILLS_EXTENSION_ID]: {},
} as const;

export const MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES = {
  [MCP_ENTERPRISE_AUTH_EXTENSION_ID]: {},
} as const;

export const MCP_OAUTH_CLIENT_CREDENTIALS_SERVER_EXTENSION_CAPABILITIES = {
  [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID]: {},
} as const;

/**
 * Declaring the skills extension commits the server to `skills/list` and
 * `skills/get`. `directoryRead` is the extension's one optional setting: it
 * additionally promises `resources/directory/read` on the skill namespace,
 * which the gateway synthesizes from each version's stored file paths.
 */
export const MCP_SKILLS_SERVER_EXTENSION_CAPABILITIES = {
  [MCP_SKILLS_EXTENSION_ID]: { directoryRead: true },
} as const;
