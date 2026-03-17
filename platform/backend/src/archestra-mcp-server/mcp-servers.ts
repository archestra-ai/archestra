import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
} from "@shared";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import McpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import logger from "@/logging";
import {
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import {
  type AgentScope,
  InsertInternalMcpCatalogSchema,
  type InternalMcpCatalog,
  UpdateInternalMcpCatalogSchema,
  UuidIdSchema,
} from "@/types";
import {
  catchError,
  deduplicateLabels,
  EmptyToolArgsSchema,
  errorResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME = "search_private_mcp_registry";
const TOOL_GET_MCP_SERVERS_NAME = "get_mcp_servers";
const TOOL_GET_MCP_SERVER_TOOLS_NAME = "get_mcp_server_tools";
const TOOL_EDIT_MCP_DESCRIPTION_NAME = "edit_mcp_description";
const TOOL_EDIT_MCP_CONFIG_NAME = "edit_mcp_config";
const TOOL_CREATE_MCP_SERVER_NAME = "create_mcp_server";
const TOOL_DEPLOY_MCP_SERVER_NAME = "deploy_mcp_server";
const TOOL_LIST_MCP_SERVER_DEPLOYMENTS_NAME = "list_mcp_server_deployments";
const TOOL_GET_MCP_SERVER_LOGS_NAME = "get_mcp_server_logs";

const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME}`;
const TOOL_GET_MCP_SERVERS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVERS_NAME}`;
const TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVER_TOOLS_NAME}`;
const TOOL_EDIT_MCP_DESCRIPTION_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_EDIT_MCP_DESCRIPTION_NAME}`;
const TOOL_EDIT_MCP_CONFIG_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_EDIT_MCP_CONFIG_NAME}`;
const TOOL_CREATE_MCP_SERVER_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_MCP_SERVER_NAME}`;
const TOOL_DEPLOY_MCP_SERVER_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DEPLOY_MCP_SERVER_NAME}`;
const TOOL_LIST_MCP_SERVER_DEPLOYMENTS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_LIST_MCP_SERVER_DEPLOYMENTS_NAME}`;
const TOOL_GET_MCP_SERVER_LOGS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVER_LOGS_NAME}`;

export const toolShortNames = [
  "search_private_mcp_registry",
  "get_mcp_servers",
  "get_mcp_server_tools",
  "edit_mcp_description",
  "edit_mcp_config",
  "create_mcp_server",
  "deploy_mcp_server",
  "list_mcp_server_deployments",
  "get_mcp_server_logs",
  "create_mcp_server_installation_request",
] as const;

const CatalogLabelSchema = z
  .object({
    key: z.string().min(1).describe("Label key."),
    value: z.string().min(1).describe("Label value."),
  })
  .strict();

const AuthFieldSchema = z
  .object({
    name: z.string().describe("Auth field name."),
    label: z.string().describe("Human-readable auth field label."),
    type: z
      .enum(["header", "query", "cookie"])
      .describe("Where to send this auth field."),
    secret: z.boolean().describe("Whether this field contains secret data."),
  })
  .strict();

const EnvVarSchema = z
  .object({
    key: z.string().describe("Environment variable name."),
    type: z
      .enum(["plain_text", "secret", "boolean", "number"])
      .describe("Environment variable value type."),
    value: z
      .string()
      .optional()
      .describe("Literal environment variable value."),
    promptOnInstallation: z
      .boolean()
      .describe("Whether to prompt for this value during installation."),
    required: z.boolean().optional().describe("Whether the value is required."),
    description: z.string().optional().describe("Description shown to users."),
    default: z.unknown().optional().describe("Default value."),
    mounted: z
      .boolean()
      .optional()
      .describe("For secret values, mount as a file instead of an env var."),
  })
  .strict();

const EnvFromSchema = z
  .object({
    type: z.enum(["secret", "configMap"]).describe("Import source type."),
    name: z.string().describe("Secret or ConfigMap name."),
    prefix: z
      .string()
      .optional()
      .describe("Optional environment variable prefix."),
  })
  .strict();

const ImagePullSecretSchema = z
  .object({
    source: z.enum(["existing"]).describe("Image pull secret source."),
    name: z.string().describe("Existing Kubernetes secret name."),
  })
  .strict();

const LooseObjectSchema = z
  .object({})
  .catchall(z.unknown())
  .describe("Arbitrary JSON object.");

const CatalogMetadataToolSchema = z
  .object({
    name: InsertInternalMcpCatalogSchema.shape.name.describe(
      "Display name for the MCP server.",
    ),
    description: InsertInternalMcpCatalogSchema.shape.description
      .optional()
      .describe("Description of the MCP server."),
    icon: InsertInternalMcpCatalogSchema.shape.icon
      .optional()
      .describe("Emoji icon for the MCP server."),
    docsUrl: InsertInternalMcpCatalogSchema.shape.docsUrl
      .optional()
      .describe("Documentation URL."),
    repository: InsertInternalMcpCatalogSchema.shape.repository
      .optional()
      .describe("Source code repository URL."),
    version: InsertInternalMcpCatalogSchema.shape.version
      .optional()
      .describe("Version string."),
    instructions: InsertInternalMcpCatalogSchema.shape.instructions
      .optional()
      .describe("Setup or usage instructions."),
    scope: InsertInternalMcpCatalogSchema.shape.scope
      .optional()
      .describe("Visibility scope."),
    labels: z
      .array(CatalogLabelSchema)
      .optional()
      .describe("Key-value labels for organization/categorization."),
    teams: z
      .array(UuidIdSchema)
      .optional()
      .describe("Team IDs for team-scoped access control."),
  })
  .strict();

const McpConfigToolSchema = z
  .object({
    serverType: InsertInternalMcpCatalogSchema.shape.serverType
      .optional()
      .describe("Server type: local, remote, or builtin."),
    serverUrl: InsertInternalMcpCatalogSchema.shape.serverUrl
      .optional()
      .describe("[Remote] The URL of the remote MCP server."),
    requiresAuth: InsertInternalMcpCatalogSchema.shape.requiresAuth
      .optional()
      .describe("[Remote] Whether the server requires authentication."),
    authDescription: InsertInternalMcpCatalogSchema.shape.authDescription
      .optional()
      .describe("[Remote] How to set up authentication."),
    authFields: z
      .array(AuthFieldSchema)
      .optional()
      .describe("[Remote] Authentication field definitions."),
    oauthConfig: LooseObjectSchema.optional().describe(
      "[Remote] OAuth configuration for the server.",
    ),
    command: z
      .string()
      .optional()
      .describe("[Local] Command to run (for example npx, uvx, or node)."),
    arguments: z
      .array(z.string())
      .optional()
      .describe("[Local] Command-line arguments."),
    environment: z
      .array(EnvVarSchema)
      .optional()
      .describe("[Local] Environment variables for the server process."),
    envFrom: z
      .array(EnvFromSchema)
      .optional()
      .describe(
        "[Local] Import env vars from Kubernetes Secrets or ConfigMaps.",
      ),
    dockerImage: z.string().optional().describe("[Local] Custom Docker image."),
    serviceAccount: z
      .string()
      .optional()
      .describe("[Local] Kubernetes ServiceAccount name."),
    transportType: z
      .enum(["stdio", "streamable-http"])
      .optional()
      .describe("[Local] Transport type."),
    httpPort: z
      .number()
      .optional()
      .describe("[Local] HTTP port for streamable-http transport."),
    httpPath: z
      .string()
      .optional()
      .describe("[Local] HTTP path for streamable-http transport."),
    nodePort: z
      .number()
      .optional()
      .describe("[Local] Kubernetes NodePort for local development."),
    imagePullSecrets: z
      .array(ImagePullSecretSchema)
      .optional()
      .describe("[Local] Image pull secrets for private registries."),
    deploymentSpecYaml: z
      .string()
      .optional()
      .describe("[Local] Custom Kubernetes deployment YAML override."),
    installationCommand: z
      .string()
      .optional()
      .describe("[Local] Command to install the MCP server package."),
    userConfig: LooseObjectSchema.optional().describe(
      "User-configurable fields shown during installation.",
    ),
  })
  .strict();

export const toolArgsSchemas = {
  [TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME]: z
    .object({
      query: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Optional search query to filter MCP servers by name or description.",
        ),
    })
    .strict(),
  [TOOL_GET_MCP_SERVERS_FULL_NAME]: EmptyToolArgsSchema,
  [TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME]: z
    .object({
      mcpServerId: UuidIdSchema.describe("The catalog ID of the MCP server."),
    })
    .strict(),
  [TOOL_EDIT_MCP_DESCRIPTION_FULL_NAME]: z
    .object({
      id: UuidIdSchema.describe(
        "The catalog ID of the MCP server to edit. Use get_mcp_servers to look it up by name.",
      ),
    })
    .merge(CatalogMetadataToolSchema.partial())
    .strict(),
  [TOOL_EDIT_MCP_CONFIG_FULL_NAME]: z
    .object({
      id: UuidIdSchema.describe(
        "The catalog ID of the MCP server to edit. Use get_mcp_servers to look it up by name.",
      ),
    })
    .merge(McpConfigToolSchema.partial())
    .strict(),
  [TOOL_CREATE_MCP_SERVER_FULL_NAME]: CatalogMetadataToolSchema.extend({
    serverType: InsertInternalMcpCatalogSchema.shape.serverType
      .optional()
      .describe("Server type: local, remote, or builtin."),
  })
    .merge(McpConfigToolSchema.partial())
    .strict(),
  [TOOL_DEPLOY_MCP_SERVER_FULL_NAME]: z
    .object({
      catalogId: UuidIdSchema.describe(
        "The catalog ID of the MCP server to deploy.",
      ),
      teamId: UuidIdSchema.optional().describe(
        "Optional team ID for a team-scoped deployment.",
      ),
      agentIds: z
        .array(UuidIdSchema)
        .optional()
        .describe(
          "Optional agent IDs to assign the server's tools to after deployment.",
        ),
    })
    .strict(),
  [TOOL_LIST_MCP_SERVER_DEPLOYMENTS_FULL_NAME]: EmptyToolArgsSchema,
  [TOOL_GET_MCP_SERVER_LOGS_FULL_NAME]: z
    .object({
      serverId: UuidIdSchema.describe("The deployment ID of the MCP server."),
      lines: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of log lines to retrieve."),
    })
    .strict(),
  [TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME]: EmptyToolArgsSchema,
} as const;

// === Exports ===

export const tools: Tool[] = [
  {
    name: TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME,
    title: "Search Private MCP Registry",
    description:
      "Search the private MCP registry for available MCP servers. Optionally provide a search query to filter results by name or description.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional search query to filter MCP servers by name or description",
        },
      },
      required: [],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_MCP_SERVERS_FULL_NAME,
    title: "Get MCP Servers",
    description:
      "List all MCP servers from the catalog. Returns catalog item IDs that can be used with mcpServerIds in create_agent/edit_agent.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME,
    title: "Get MCP Server Tools",
    description:
      "Get all tools available for a specific MCP server by its catalog ID (from get_mcp_servers).",
    inputSchema: {
      type: "object",
      properties: {
        mcpServerId: {
          type: "string",
          description: "The catalog ID of the MCP server",
        },
      },
      required: ["mcpServerId"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_EDIT_MCP_DESCRIPTION_FULL_NAME,
    title: "Edit MCP Server Description",
    description:
      "Edit an MCP server's display information and metadata. Use get_mcp_servers to look up IDs by name. Changing scope requires admin permissions.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The catalog ID of the MCP server to edit. Use get_mcp_servers to look up by name.",
        },
        name: {
          type: "string",
          description: "New display name for the MCP server",
        },
        icon: {
          type: "string",
          description: "An emoji character to use as the MCP server icon",
        },
        description: {
          type: "string",
          description: "New description for the MCP server",
        },
        docsUrl: {
          type: "string",
          description: "Documentation URL",
        },
        repository: {
          type: "string",
          description: "Source code repository URL",
        },
        version: {
          type: "string",
          description: "Version string",
        },
        instructions: {
          type: "string",
          description: "Setup or usage instructions",
        },
        scope: {
          type: "string",
          enum: ["personal", "team", "org"],
          description:
            "Visibility scope. Changing scope requires admin permissions.",
        },
        labels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "string" },
            },
            required: ["key", "value"],
          },
          description: "Key-value labels for organization/categorization",
        },
        teams: {
          type: "array",
          items: { type: "string" },
          description: "Team IDs for team-scoped access control",
        },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_EDIT_MCP_CONFIG_FULL_NAME,
    title: "Edit MCP Server Configuration",
    description:
      "Edit an MCP server's technical configuration. For remote servers: use serverUrl, auth, and OAuth fields. For local (K8s) servers: use command, arguments, environment, Docker, and transport fields. Local config fields are merged into the existing configuration — only specified fields are overwritten. Use get_mcp_servers to look up IDs by name.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "The catalog ID of the MCP server to edit. Use get_mcp_servers to look up by name.",
        },
        serverType: {
          type: "string",
          enum: ["local", "remote", "builtin"],
          description:
            "Server type: local (K8s pod), remote (HTTP URL), or builtin",
        },
        serverUrl: {
          type: "string",
          description: "[Remote] The URL of the remote MCP server",
        },
        requiresAuth: {
          type: "boolean",
          description: "[Remote] Whether the server requires authentication",
        },
        authDescription: {
          type: "string",
          description: "[Remote] Description of how to set up authentication",
        },
        authFields: {
          type: "array",
          description: "[Remote] Authentication field definitions",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              label: { type: "string" },
              type: {
                type: "string",
                enum: ["header", "query", "cookie"],
              },
              secret: { type: "boolean" },
            },
            required: ["name", "label", "type", "secret"],
          },
        },
        oauthConfig: {
          type: "object",
          description: "[Remote] OAuth configuration for the server",
        },
        command: {
          type: "string",
          description: "[Local] The command to run (e.g. 'npx', 'uvx', 'node')",
        },
        arguments: {
          type: "array",
          items: { type: "string" },
          description: "[Local] Command-line arguments",
        },
        environment: {
          type: "array",
          description: "[Local] Environment variables for the server process",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              type: {
                type: "string",
                enum: ["plain_text", "secret", "boolean", "number"],
              },
              value: { type: "string" },
              promptOnInstallation: { type: "boolean" },
              required: { type: "boolean" },
              description: { type: "string" },
              default: {},
              mounted: { type: "boolean" },
            },
            required: ["key", "type", "promptOnInstallation"],
          },
        },
        envFrom: {
          type: "array",
          description:
            "[Local] Import environment variables from K8s Secrets or ConfigMaps",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["secret", "configMap"],
              },
              name: { type: "string" },
              prefix: { type: "string" },
            },
            required: ["type", "name"],
          },
        },
        dockerImage: {
          type: "string",
          description:
            "[Local] Custom Docker image (overrides the base MCP server image)",
        },
        serviceAccount: {
          type: "string",
          description: "[Local] K8s ServiceAccount name for the pod",
        },
        transportType: {
          type: "string",
          enum: ["stdio", "streamable-http"],
          description:
            "[Local] Transport type: stdio (default, JSON-RPC proxy) or streamable-http (native HTTP/SSE)",
        },
        httpPort: {
          type: "number",
          description:
            "[Local] HTTP port for streamable-http transport (default: 8080)",
        },
        httpPath: {
          type: "string",
          description:
            "[Local] HTTP path for streamable-http transport (default: /mcp)",
        },
        nodePort: {
          type: "number",
          description: "[Local] K8s NodePort for local dev access",
        },
        imagePullSecrets: {
          type: "array",
          description:
            "[Local] Image pull secrets for private Docker registries",
          items: {
            type: "object",
            properties: {
              source: {
                type: "string",
                enum: ["existing"],
              },
              name: { type: "string" },
            },
            required: ["source", "name"],
          },
        },
        deploymentSpecYaml: {
          type: "string",
          description: "[Local] Custom K8s deployment YAML override",
        },
        installationCommand: {
          type: "string",
          description: "[Local] Command to install the MCP server package",
        },
        userConfig: {
          type: "object",
          description:
            "User-configurable fields shown during installation (shared by both remote and local)",
        },
      },
      required: ["id"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_CREATE_MCP_SERVER_FULL_NAME,
    title: "Create MCP Server",
    description:
      "Create a new MCP server in the private registry. Specify serverType to choose between local (K8s pod) or remote (HTTP URL). For local servers, provide command/arguments/environment. For remote servers, provide serverUrl and auth configuration. Defaults to personal scope.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name for the MCP server",
        },
        serverType: {
          type: "string",
          enum: ["local", "remote", "builtin"],
          description:
            "Server type: local (K8s pod, default), remote (HTTP URL), or builtin",
        },
        description: {
          type: "string",
          description: "Description of the MCP server",
        },
        icon: {
          type: "string",
          description: "An emoji character to use as the MCP server icon",
        },
        docsUrl: {
          type: "string",
          description: "Documentation URL",
        },
        repository: {
          type: "string",
          description: "Source code repository URL",
        },
        version: {
          type: "string",
          description: "Version string",
        },
        instructions: {
          type: "string",
          description: "Setup or usage instructions",
        },
        serverUrl: {
          type: "string",
          description: "[Remote] The URL of the remote MCP server",
        },
        requiresAuth: {
          type: "boolean",
          description: "[Remote] Whether the server requires authentication",
        },
        authDescription: {
          type: "string",
          description: "[Remote] Description of how to set up authentication",
        },
        authFields: {
          type: "array",
          description: "[Remote] Authentication field definitions",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              label: { type: "string" },
              type: {
                type: "string",
                enum: ["header", "query", "cookie"],
              },
              secret: { type: "boolean" },
            },
            required: ["name", "label", "type", "secret"],
          },
        },
        oauthConfig: {
          type: "object",
          description: "[Remote] OAuth configuration for the server",
        },
        command: {
          type: "string",
          description: "[Local] The command to run (e.g. 'npx', 'uvx', 'node')",
        },
        arguments: {
          type: "array",
          items: { type: "string" },
          description: "[Local] Command-line arguments",
        },
        environment: {
          type: "array",
          description: "[Local] Environment variables for the server process",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              type: {
                type: "string",
                enum: ["plain_text", "secret", "boolean", "number"],
              },
              value: { type: "string" },
              promptOnInstallation: { type: "boolean" },
              required: { type: "boolean" },
              description: { type: "string" },
              default: {},
              mounted: { type: "boolean" },
            },
            required: ["key", "type", "promptOnInstallation"],
          },
        },
        envFrom: {
          type: "array",
          description:
            "[Local] Import environment variables from K8s Secrets or ConfigMaps",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["secret", "configMap"],
              },
              name: { type: "string" },
              prefix: { type: "string" },
            },
            required: ["type", "name"],
          },
        },
        dockerImage: {
          type: "string",
          description:
            "[Local] Custom Docker image (overrides the base MCP server image)",
        },
        serviceAccount: {
          type: "string",
          description: "[Local] K8s ServiceAccount name for the pod",
        },
        transportType: {
          type: "string",
          enum: ["stdio", "streamable-http"],
          description:
            "[Local] Transport type: stdio (default, JSON-RPC proxy) or streamable-http (native HTTP/SSE)",
        },
        httpPort: {
          type: "number",
          description:
            "[Local] HTTP port for streamable-http transport (default: 8080)",
        },
        httpPath: {
          type: "string",
          description:
            "[Local] HTTP path for streamable-http transport (default: /mcp)",
        },
        nodePort: {
          type: "number",
          description: "[Local] K8s NodePort for local dev access",
        },
        imagePullSecrets: {
          type: "array",
          description:
            "[Local] Image pull secrets for private Docker registries",
          items: {
            type: "object",
            properties: {
              source: {
                type: "string",
                enum: ["existing"],
              },
              name: { type: "string" },
            },
            required: ["source", "name"],
          },
        },
        deploymentSpecYaml: {
          type: "string",
          description: "[Local] Custom K8s deployment YAML override",
        },
        installationCommand: {
          type: "string",
          description: "[Local] Command to install the MCP server package",
        },
        userConfig: {
          type: "object",
          description:
            "User-configurable fields shown during installation (shared by both remote and local)",
        },
        scope: {
          type: "string",
          enum: ["personal", "team", "org"],
          description:
            "Visibility scope (default: personal, or team if teams provided). Non-personal scopes require admin.",
        },
        labels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "string" },
            },
            required: ["key", "value"],
          },
          description: "Key-value labels for organization/categorization",
        },
        teams: {
          type: "array",
          items: { type: "string" },
          description: "Team IDs for team-scoped access control",
        },
      },
      required: ["name"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_DEPLOY_MCP_SERVER_FULL_NAME,
    title: "Deploy MCP Server",
    description:
      "Deploy (install) an MCP server from the catalog. Creates a running instance. Only works for servers that do not require authentication — if auth is needed, tells the user to install via the UI. Use get_mcp_servers to find the catalog ID. Optionally assign the server's tools to agents.",
    inputSchema: {
      type: "object",
      properties: {
        catalogId: {
          type: "string",
          description:
            "The catalog ID of the MCP server to deploy. Use get_mcp_servers to look up by name.",
        },
        teamId: {
          type: "string",
          description:
            "Optional team ID for a team-scoped deployment. If omitted, deploys as a personal server.",
        },
        agentIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional agent IDs to assign the server's tools to after deployment.",
        },
      },
      required: ["catalogId"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_LIST_MCP_SERVER_DEPLOYMENTS_FULL_NAME,
    title: "List MCP Server Deployments",
    description:
      "List all deployed (installed) MCP server instances accessible to the current user. Shows deployment status, server type, catalog info, team, and owner.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_GET_MCP_SERVER_LOGS_FULL_NAME,
    title: "Get MCP Server Logs",
    description:
      "Get recent container logs from a deployed local (K8s) MCP server. Use list_mcp_server_deployments to find the server ID. Only works for local servers with K8s runtime enabled.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: {
          type: "string",
          description:
            "The deployment ID of the MCP server (from list_mcp_server_deployments).",
        },
        lines: {
          type: "number",
          description:
            "Number of log lines to retrieve (default: 100, max recommended: 500).",
        },
      },
      required: ["serverId"],
    },
    annotations: {},
    _meta: {},
  },
  {
    name: TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
    title: "Create MCP Server Installation Request",
    description:
      "Allows users from within the Archestra Platform chat UI to submit a request for an MCP server to be added to their Archestra Platform's internal MCP server registry. This will open a dialog for the user to submit an installation request. When you trigger this tool, just tell the user to go through the dialog to submit the request. Do not provider any additional information",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: {},
    _meta: {},
  },
];

export async function handleTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<ReturnType<typeof successResult> | null> {
  const { agent: contextAgent, organizationId } = context;

  if (toolName === TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, searchArgs: args },
      "search_private_mcp_registry tool called",
    );

    try {
      const query = args?.query as string | undefined;

      let catalogItems: InternalMcpCatalog[];

      if (query && query.trim() !== "") {
        catalogItems = await InternalMcpCatalogModel.searchByQuery(query, {
          expandSecrets: false,
        });
      } else {
        catalogItems = await InternalMcpCatalogModel.findAll({
          expandSecrets: false,
        });
      }

      if (catalogItems.length === 0) {
        return successResult(
          query
            ? `No MCP servers found matching query: "${query}"`
            : "No MCP servers found in the private registry.",
        );
      }

      const formattedResults = catalogItems
        .map((item) => {
          let result = `**${item.name}**`;
          if (item.version) result += ` (v${item.version})`;
          if (item.description) result += `\n  ${item.description}`;
          result += `\n  Type: ${item.serverType}`;
          if (item.serverUrl) result += `\n  URL: ${item.serverUrl}`;
          if (item.repository) result += `\n  Repository: ${item.repository}`;
          result += `\n  ID: ${item.id}`;
          return result;
        })
        .join("\n\n");

      return successResult(
        `Found ${catalogItems.length} MCP server(s):\n\n${formattedResults}`,
      );
    } catch (error) {
      return catchError(error, "searching private MCP registry");
    }
  }

  if (toolName === TOOL_GET_MCP_SERVERS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, filters: args },
      "get_mcp_servers tool called",
    );

    try {
      const catalogItems = await InternalMcpCatalogModel.findAll({
        expandSecrets: false,
      });

      const items = catalogItems.map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        description: c.description,
        scope: c.scope,
        teams: c.teams?.map((t) => ({ id: t.id, name: t.name })) ?? [],
      }));

      return successResult(JSON.stringify(items, null, 2));
    } catch (error) {
      return catchError(error, "getting MCP servers");
    }
  }

  if (toolName === TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, mcpServerId: args?.mcpServerId },
      "get_mcp_server_tools tool called",
    );

    try {
      const mcpServerId = args?.mcpServerId as string;

      if (!mcpServerId) {
        return errorResult("mcpServerId parameter is required");
      }

      const tools = await ToolModel.findByCatalogId(mcpServerId);

      return successResult(JSON.stringify(tools, null, 2));
    } catch (error) {
      return catchError(error, "getting MCP server tools");
    }
  }

  if (toolName === TOOL_EDIT_MCP_DESCRIPTION_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, editArgs: args },
      "edit_mcp_description tool called",
    );

    try {
      const id = args?.id as string | undefined;
      if (!id) {
        return errorResult("MCP server catalog id is required.");
      }

      if (!context.userId || !organizationId) {
        return errorResult("user/organization context not available.");
      }

      const existing = await InternalMcpCatalogModel.findById(id);
      if (!existing) {
        return errorResult("MCP server not found.");
      }

      const isAdmin = await userHasPermission(
        context.userId,
        organizationId,
        "mcpServerInstallation",
        "admin",
      );

      if (!isAdmin) {
        if (
          existing.scope !== "personal" ||
          existing.authorId !== context.userId
        ) {
          return errorResult(
            "you can only edit your own personal MCP servers.",
          );
        }
      }

      // Scope changes require admin permission
      if (args?.scope !== undefined && args.scope !== existing.scope) {
        if (!isAdmin) {
          return errorResult("only admins can change MCP server scope.");
        }
      }

      const descriptionFields = [
        "name",
        "icon",
        "description",
        "docsUrl",
        "repository",
        "version",
        "instructions",
        "scope",
        "labels",
        "teams",
      ] as const;

      const updateData: Record<string, unknown> = {};
      for (const field of descriptionFields) {
        if (args?.[field] !== undefined) {
          updateData[field] = args[field];
        }
      }

      if (Object.keys(updateData).length === 0) {
        return errorResult(
          `No fields to update. Provide at least one of: ${descriptionFields.join(", ")}.`,
        );
      }

      const validatedUpdate =
        UpdateInternalMcpCatalogSchema.partial().parse(updateData);
      const updated = await InternalMcpCatalogModel.update(
        existing.id,
        validatedUpdate,
      );

      if (!updated) {
        return errorResult("failed to update MCP server.");
      }

      const lines = [
        "Successfully updated MCP server.",
        "",
        `Name: ${updated.name}`,
        `ID: ${updated.id}`,
        `Icon: ${updated.icon || "None"}`,
        `Description: ${updated.description || "None"}`,
        `Scope: ${updated.scope}`,
      ];
      if (updated.docsUrl) lines.push(`Docs URL: ${updated.docsUrl}`);
      if (updated.repository) lines.push(`Repository: ${updated.repository}`);
      if (updated.version) lines.push(`Version: ${updated.version}`);

      return successResult(lines.join("\n"));
    } catch (error) {
      return catchError(error, "editing MCP server description");
    }
  }

  if (toolName === TOOL_EDIT_MCP_CONFIG_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, editArgs: args },
      "edit_mcp_config tool called",
    );

    try {
      const id = args?.id as string | undefined;
      if (!id) {
        return errorResult("MCP server catalog id is required.");
      }

      if (!context.userId || !organizationId) {
        return errorResult("user/organization context not available.");
      }

      const existing = await InternalMcpCatalogModel.findById(id);
      if (!existing) {
        return errorResult("MCP server not found.");
      }

      const isAdmin = await userHasPermission(
        context.userId,
        organizationId,
        "mcpServerInstallation",
        "admin",
      );

      if (!isAdmin) {
        if (
          existing.scope !== "personal" ||
          existing.authorId !== context.userId
        ) {
          return errorResult(
            "you can only edit your own personal MCP servers.",
          );
        }
      }

      const updateData: Record<string, unknown> = {};

      // Server type
      if (args?.serverType !== undefined)
        updateData.serverType = args.serverType;

      // Remote server fields
      if (args?.serverUrl !== undefined) updateData.serverUrl = args.serverUrl;
      if (args?.requiresAuth !== undefined)
        updateData.requiresAuth = args.requiresAuth;
      if (args?.authDescription !== undefined)
        updateData.authDescription = args.authDescription;
      if (args?.authFields !== undefined)
        updateData.authFields = args.authFields;
      if (args?.oauthConfig !== undefined)
        updateData.oauthConfig = args.oauthConfig;

      // Local server fields — merged into existing localConfig
      const localConfigUpdates: Record<string, unknown> = {};
      const localFields = [
        "command",
        "arguments",
        "environment",
        "envFrom",
        "dockerImage",
        "serviceAccount",
        "transportType",
        "httpPort",
        "httpPath",
        "nodePort",
        "imagePullSecrets",
      ] as const;
      for (const field of localFields) {
        if (args?.[field] !== undefined) {
          localConfigUpdates[field] = args[field];
        }
      }
      if (Object.keys(localConfigUpdates).length > 0) {
        updateData.localConfig = {
          ...(existing.localConfig ?? {}),
          ...localConfigUpdates,
        };
      }

      if (args?.deploymentSpecYaml !== undefined)
        updateData.deploymentSpecYaml = args.deploymentSpecYaml;
      if (args?.installationCommand !== undefined)
        updateData.installationCommand = args.installationCommand;

      // Shared
      if (args?.userConfig !== undefined)
        updateData.userConfig = args.userConfig;

      if (Object.keys(updateData).length === 0) {
        return errorResult(
          "No fields to update. Provide at least one configuration field.",
        );
      }

      const validatedUpdate =
        UpdateInternalMcpCatalogSchema.partial().parse(updateData);
      const updated = await InternalMcpCatalogModel.update(
        existing.id,
        validatedUpdate,
      );

      if (!updated) {
        return errorResult("failed to update MCP server config.");
      }

      const lines = [
        "Successfully updated MCP server configuration.",
        "",
        `Name: ${updated.name}`,
        `ID: ${updated.id}`,
        `Server Type: ${updated.serverType}`,
      ];
      if (updated.serverUrl) lines.push(`Server URL: ${updated.serverUrl}`);
      if (updated.installationCommand)
        lines.push(`Installation Command: ${updated.installationCommand}`);
      if (updated.localConfig)
        lines.push(`Local Config: ${JSON.stringify(updated.localConfig)}`);
      if (updated.deploymentSpecYaml)
        lines.push("Deployment Spec: (custom YAML set)");

      return successResult(lines.join("\n"));
    } catch (error) {
      return catchError(error, "editing MCP server config");
    }
  }

  if (toolName === TOOL_CREATE_MCP_SERVER_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, createArgs: args },
      "create_mcp_server tool called",
    );

    try {
      const name = args?.name as string;
      if (!name || name.trim() === "") {
        return errorResult("MCP server name is required and cannot be empty.");
      }

      if (!context.userId || !organizationId) {
        return errorResult("user/organization context not available.");
      }

      const serverType = (args?.serverType as string) ?? "local";
      if (!["local", "remote", "builtin"].includes(serverType)) {
        return errorResult(
          "serverType must be one of: local, remote, builtin.",
        );
      }

      const teams = (args?.teams as string[]) ?? [];
      const rawLabels = args?.labels as
        | Array<{ key: string; value: string }>
        | undefined;
      const labels = rawLabels ? deduplicateLabels(rawLabels) : undefined;

      const scope =
        (args?.scope as AgentScope) ?? (teams.length > 0 ? "team" : "personal");

      // Non-admins can only create personal servers
      const isAdmin = await userHasPermission(
        context.userId,
        organizationId,
        "mcpServerInstallation",
        "admin",
      );
      if (!isAdmin && scope !== "personal") {
        return errorResult(
          "only admins can create team or org-scoped MCP servers.",
        );
      }

      // Build localConfig from individual fields
      const localConfigFields = [
        "command",
        "arguments",
        "environment",
        "envFrom",
        "dockerImage",
        "serviceAccount",
        "transportType",
        "httpPort",
        "httpPath",
        "nodePort",
        "imagePullSecrets",
      ] as const;
      const localConfig: Record<string, unknown> = {};
      for (const field of localConfigFields) {
        if (args?.[field] !== undefined) {
          localConfig[field] = args[field];
        }
      }

      const createParams: Record<string, unknown> = {
        name,
        serverType: serverType as "local" | "remote" | "builtin",
        scope,
      };

      // Description fields
      if (args?.description !== undefined)
        createParams.description = args.description;
      if (args?.icon !== undefined) createParams.icon = args.icon;
      if (args?.docsUrl !== undefined) createParams.docsUrl = args.docsUrl;
      if (args?.repository !== undefined)
        createParams.repository = args.repository;
      if (args?.version !== undefined) createParams.version = args.version;
      if (args?.instructions !== undefined)
        createParams.instructions = args.instructions;

      // Remote server fields
      if (args?.serverUrl !== undefined)
        createParams.serverUrl = args.serverUrl;
      if (args?.requiresAuth !== undefined)
        createParams.requiresAuth = args.requiresAuth;
      if (args?.authDescription !== undefined)
        createParams.authDescription = args.authDescription;
      if (args?.authFields !== undefined)
        createParams.authFields = args.authFields;
      if (args?.oauthConfig !== undefined)
        createParams.oauthConfig = args.oauthConfig;

      // Local server fields
      if (Object.keys(localConfig).length > 0)
        createParams.localConfig = localConfig;
      if (args?.deploymentSpecYaml !== undefined)
        createParams.deploymentSpecYaml = args.deploymentSpecYaml;
      if (args?.installationCommand !== undefined)
        createParams.installationCommand = args.installationCommand;

      // Shared
      if (args?.userConfig !== undefined)
        createParams.userConfig = args.userConfig;
      if (labels) createParams.labels = labels;
      if (teams.length > 0) createParams.teams = teams;

      const validatedParams =
        InsertInternalMcpCatalogSchema.parse(createParams);
      const created = await InternalMcpCatalogModel.create(validatedParams, {
        organizationId,
        authorId: context.userId,
      });

      const lines = [
        "Successfully created MCP server.",
        "",
        `Name: ${created.name}`,
        `ID: ${created.id}`,
        `Server Type: ${created.serverType}`,
        `Scope: ${created.scope}`,
      ];
      if (created.description)
        lines.push(`Description: ${created.description}`);
      if (created.serverUrl) lines.push(`Server URL: ${created.serverUrl}`);
      if (created.localConfig)
        lines.push(`Local Config: ${JSON.stringify(created.localConfig)}`);
      if (created.teams.length > 0)
        lines.push(`Teams: ${created.teams.map((t) => t.name).join(", ")}`);
      if (created.labels.length > 0)
        lines.push(
          `Labels: ${created.labels.map((l) => `${l.key}: ${l.value}`).join(", ")}`,
        );

      return successResult(lines.join("\n"));
    } catch (error) {
      return catchError(error, "creating MCP server");
    }
  }

  // === deploy_mcp_server: Install/deploy a catalog MCP server (no auth) ===
  if (toolName === TOOL_DEPLOY_MCP_SERVER_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, deployArgs: args },
      "deploy_mcp_server tool called",
    );

    try {
      const catalogId = args?.catalogId as string | undefined;
      if (!catalogId) {
        return errorResult("catalogId is required.");
      }

      if (!context.userId || !organizationId) {
        return errorResult("user/organization context not available.");
      }

      const catalogItem = await InternalMcpCatalogModel.findById(catalogId);
      if (!catalogItem) {
        return errorResult("catalog item not found.");
      }

      // Block servers that require authentication
      if (catalogItem.requiresAuth || catalogItem.oauthConfig) {
        return errorResult(
          "This MCP server requires authentication. Please install it through the UI at /mcp/registry where you can provide credentials.",
        );
      }

      // Block servers with required prompted environment variables (secrets the user must provide)
      const requiredPromptedEnvVars =
        catalogItem.localConfig?.environment?.filter(
          (env) => env.promptOnInstallation && env.required,
        ) ?? [];
      if (requiredPromptedEnvVars.length > 0) {
        return errorResult(
          `This MCP server requires environment variables to be provided during installation: ${requiredPromptedEnvVars.map((e) => e.key).join(", ")}. Please install it through the UI at /mcp/registry.`,
        );
      }

      const teamId = args?.teamId as string | undefined;

      // Check for duplicate installations
      const existingServers = await McpServerModel.findByCatalogId(catalogId);
      if (!teamId) {
        const existingPersonal = existingServers.find(
          (s) => s.ownerId === context.userId && !s.teamId,
        );
        if (existingPersonal) {
          return successResult(
            [
              "This MCP server is already installed (returning existing deployment).",
              "",
              `Name: ${existingPersonal.name}`,
              `ID: ${existingPersonal.id}`,
              `Status: ${existingPersonal.localInstallationStatus}`,
            ].join("\n"),
          );
        }
      } else {
        const existingTeam = existingServers.find((s) => s.teamId === teamId);
        if (existingTeam) {
          return errorResult(
            "This team already has an installation of this MCP server.",
          );
        }
      }

      // Create the MCP server record
      const mcpServer = await McpServerModel.create({
        name: catalogItem.name,
        catalogId,
        serverType: catalogItem.serverType,
        ownerId: context.userId,
        userId: context.userId,
        ...(teamId && { teamId }),
      });

      // For local servers, start K8s deployment
      if (catalogItem.serverType === "local") {
        if (!McpServerRuntimeManager.isEnabled) {
          return successResult(
            [
              "MCP server record created but K8s runtime is not available. The server cannot be deployed.",
              "",
              `Name: ${mcpServer.name}`,
              `ID: ${mcpServer.id}`,
            ].join("\n"),
          );
        }

        await McpServerModel.update(mcpServer.id, {
          localInstallationStatus: "pending",
          localInstallationError: null,
        });

        await McpServerRuntimeManager.startServer(mcpServer);

        // Discover tools asynchronously (fire-and-forget)
        const capturedCatalogId = catalogItem.id;
        const capturedCatalogName = catalogItem.name;
        (async () => {
          try {
            const k8sDeployment =
              await McpServerRuntimeManager.getOrLoadDeployment(mcpServer.id);
            if (!k8sDeployment) {
              throw new Error("Deployment manager not found");
            }

            await k8sDeployment.waitForDeploymentReady(60, 2000);

            await McpServerModel.update(mcpServer.id, {
              localInstallationStatus: "discovering-tools",
              localInstallationError: null,
            });

            const discoveredTools =
              await McpServerModel.getToolsFromServer(mcpServer);

            const toolsToCreate = discoveredTools.map((tool) => ({
              name: ToolModel.slugifyName(
                capturedCatalogName || mcpServer.name,
                tool.name,
              ),
              description: tool.description,
              parameters: tool.inputSchema,
              catalogId: capturedCatalogId,
            }));

            if (toolsToCreate.length > 0) {
              const createdTools =
                await ToolModel.bulkCreateToolsIfNotExists(toolsToCreate);

              // Assign tools to agents if requested
              const reqAgentIds = (args?.agentIds as string[]) ?? [];
              if (reqAgentIds.length > 0) {
                const toolIds = createdTools.map((t) => t.id);
                await AgentToolModel.bulkCreateForAgentsAndTools(
                  reqAgentIds,
                  toolIds,
                  { executionSourceMcpServerId: mcpServer.id },
                );
              }
            }

            await McpServerModel.update(mcpServer.id, {
              localInstallationStatus: "success",
              localInstallationError: null,
            });
          } catch (err) {
            logger.error(
              { err, mcpServerId: mcpServer.id },
              "Error during async tool discovery after deploy",
            );
            await McpServerModel.update(mcpServer.id, {
              localInstallationStatus: "error",
              localInstallationError:
                err instanceof Error ? err.message : "Unknown error",
            });
          }
        })();
      }

      // For remote servers, fetch tools synchronously and assign to agents
      if (catalogItem.serverType === "remote") {
        try {
          const discoveredTools =
            await McpServerModel.getToolsFromServer(mcpServer);
          if (discoveredTools.length > 0) {
            const toolsToCreate = discoveredTools.map((tool) => ({
              name: ToolModel.slugifyName(catalogItem.name, tool.name),
              description: tool.description,
              parameters: tool.inputSchema,
              catalogId: catalogItem.id,
            }));
            const createdTools =
              await ToolModel.bulkCreateToolsIfNotExists(toolsToCreate);

            const reqAgentIds = (args?.agentIds as string[]) ?? [];
            if (reqAgentIds.length > 0) {
              const toolIds = createdTools.map((t) => t.id);
              await AgentToolModel.bulkCreateForAgentsAndTools(
                reqAgentIds,
                toolIds,
                { executionSourceMcpServerId: mcpServer.id },
              );
            }
          }
        } catch (err) {
          logger.error(
            { err, mcpServerId: mcpServer.id },
            "Error fetching tools from remote server",
          );
        }
      }

      const lines = [
        "Successfully deployed MCP server.",
        "",
        `Name: ${mcpServer.name}`,
        `ID: ${mcpServer.id}`,
        `Server Type: ${catalogItem.serverType}`,
        `Status: ${catalogItem.serverType === "local" ? "pending (deploying to K8s)" : "ready"}`,
      ];

      return successResult(lines.join("\n"));
    } catch (error) {
      return catchError(error, "deploying MCP server");
    }
  }

  // === list_mcp_server_deployments: List installed MCP server instances ===
  if (toolName === TOOL_LIST_MCP_SERVER_DEPLOYMENTS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id },
      "list_mcp_server_deployments tool called",
    );

    try {
      if (!context.userId || !organizationId) {
        return errorResult("user/organization context not available.");
      }

      const isAdmin = await userHasPermission(
        context.userId,
        organizationId,
        "mcpServerInstallation",
        "admin",
      );

      const servers = await McpServerModel.findAll(context.userId, isAdmin);

      if (servers.length === 0) {
        return successResult("No MCP server deployments found.");
      }

      const lines = [`Found ${servers.length} MCP server deployment(s):`, ""];
      for (const server of servers) {
        lines.push(`- ${server.name}`);
        lines.push(`  ID: ${server.id}`);
        lines.push(`  Type: ${server.serverType}`);
        lines.push(`  Catalog: ${server.catalogName || "custom"}`);
        if (server.catalogId) lines.push(`  Catalog ID: ${server.catalogId}`);
        lines.push(`  Status: ${server.localInstallationStatus}`);
        if (server.localInstallationError)
          lines.push(`  Error: ${server.localInstallationError}`);
        if (server.teamDetails)
          lines.push(`  Team: ${server.teamDetails.name}`);
        if (server.ownerEmail) lines.push(`  Owner: ${server.ownerEmail}`);
        lines.push("");
      }

      return successResult(lines.join("\n"));
    } catch (error) {
      return catchError(error, "listing MCP server deployments");
    }
  }

  // === get_mcp_server_logs: Get logs from a deployed MCP server ===
  if (toolName === TOOL_GET_MCP_SERVER_LOGS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, logsArgs: args },
      "get_mcp_server_logs tool called",
    );

    try {
      const serverId = args?.serverId as string | undefined;
      if (!serverId) {
        return errorResult("serverId is required.");
      }

      if (!context.userId || !organizationId) {
        return errorResult("user/organization context not available.");
      }

      // Verify access
      const isAdmin = await userHasPermission(
        context.userId,
        organizationId,
        "mcpServerInstallation",
        "admin",
      );

      const server = await McpServerModel.findById(
        serverId,
        context.userId,
        isAdmin,
      );
      if (!server) {
        return errorResult("MCP server not found or you don't have access.");
      }

      if (server.serverType !== "local") {
        return successResult(
          "Logs are only available for local (K8s) MCP servers.",
        );
      }

      if (!McpServerRuntimeManager.isEnabled) {
        return errorResult(
          "K8s runtime is not available. Cannot retrieve logs.",
        );
      }

      const lineCount = (args?.lines as number) ?? 100;
      const logsResult = await McpServerRuntimeManager.getMcpServerLogs(
        serverId,
        lineCount,
      );

      const output = [
        `Logs for ${server.name} (last ${lineCount} lines):`,
        `Container: ${logsResult.containerName}`,
        `Command: ${logsResult.command}`,
        "",
        logsResult.logs || "(no logs available)",
      ];

      return successResult(output.join("\n"));
    } catch (error) {
      return catchError(error, "getting MCP server logs");
    }
  }

  /**
   * This tool is quite unique in that the tool handler doesn't actually need to do anything
   * see the useChat() usage in the chat UI for more details
   */
  if (toolName === TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, requestArgs: args },
      "create_mcp_server_installation_request tool called",
    );

    try {
      return successResult(
        "A dialog for adding or requesting an MCP server should now be visible in the chat. Please review and submit to proceed.",
      );
    } catch (error) {
      return catchError(error, "handling MCP server installation request");
    }
  }

  return null;
}
