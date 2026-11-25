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

/**
 * File Uploads extension: tools take files through `x-mcp-file` arguments,
 * either inline (`data`) or uploaded out of band after an `upload_required`
 * result. Only defined for protocol 2026-07-28 and later.
 * https://github.com/modelcontextprotocol/experimental-ext-file-uploads
 */
export const MCP_FILES_EXTENSION_ID = "io.modelcontextprotocol/files";

/** JSON Schema keyword that marks an argument as a file. */
export const MCP_FILE_SCHEMA_KEYWORD = "x-mcp-file";
/** The `resultType` of a server's request for out-of-band file uploads. */
export const MCP_UPLOAD_REQUIRED_RESULT_TYPE = "upload_required";

/** Largest total inline file `data` the MCP gateway accepts in one call. */
export const MCP_GATEWAY_MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024;

/**
 * The gateway relays out-of-band uploads and accepts inline files. It never
 * declares `download`: that setting is the client's.
 */
export const MCP_FILES_SERVER_EXTENSION_CAPABILITIES = {
  [MCP_FILES_EXTENSION_ID]: {
    upload: {},
    maxInlineBytes: MCP_GATEWAY_MAX_INLINE_FILE_BYTES,
  },
} as const;
