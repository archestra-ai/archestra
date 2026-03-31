import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_CREATE_AGENT_SHORT_NAME,
  TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_SHORT_NAME,
  TOOL_CREATE_MCP_SERVER_SHORT_NAME,
  TOOL_DEPLOY_MCP_SERVER_SHORT_NAME,
  TOOL_EDIT_AGENT_SHORT_NAME,
  TOOL_EDIT_MCP_CONFIG_SHORT_NAME,
  TOOL_EDIT_MCP_DESCRIPTION_SHORT_NAME,
  TOOL_GET_MCP_SERVER_LOGS_SHORT_NAME,
  TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME,
  TOOL_GET_MCP_SERVERS_SHORT_NAME,
  TOOL_LIST_MCP_SERVER_DEPLOYMENTS_SHORT_NAME,
  TOOL_SEARCH_PRIVATE_MCP_REGISTRY_SHORT_NAME,
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
  InsertInternalMcpCatalogSchema,
  type InternalMcpCatalog,
  PartialUpdateInternalMcpCatalogSchema,
  UuidIdSchema,
} from "@/types";
import {
  catchError,
  deduplicateLabels,
  defineArchestraTool,
  defineArchestraTools,
  EmptyToolArgsSchema,
  errorResult,
  structuredSuccessResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

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

const SearchPrivateMcpRegistryOutputSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().describe("The catalog item ID."),
        name: z.string().describe("The MCP server name."),
        version: z.string().nullable().describe("The version, if provided."),
        description: z
          .string()
          .nullable()
          .describe("The server description, if any."),
        serverType: InsertInternalMcpCatalogSchema.shape.serverType.describe(
          "Whether the server is local, remote, or builtin.",
        ),
        serverUrl: z
          .string()
          .nullable()
          .describe("The remote server URL, if applicable."),
        repository: z
          .string()
          .nullable()
          .describe("The repository URL, if available."),
      }),
    )
    .describe("Catalog items matching the search."),
});

const McpServerListItemOutputSchema = z.object({
  id: z.string().describe("The catalog item ID."),
  name: z.string().describe("The MCP server name."),
  icon: z.string().nullable().describe("The emoji icon, if any."),
  description: z
    .string()
    .nullable()
    .describe("The server description, if any."),
  scope: InsertInternalMcpCatalogSchema.shape.scope.describe(
    "The visibility scope of the server.",
  ),
  teams: z
    .array(
      z.object({
        id: z.string().describe("The team ID."),
        name: z.string().describe("The team name."),
      }),
    )
    .describe("Teams attached to a team-scoped server."),
});

const GetMcpServersOutputSchema = z.object({
  items: z
    .array(McpServerListItemOutputSchema)
    .describe("Available MCP servers."),
});

const McpServerToolOutputSchema = z.object({
  id: z.string().describe("The tool ID."),
  name: z.string().describe("The tool name."),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("The tool description, if any."),
  catalogId: z
    .string()
    .nullable()
    .optional()
    .describe("The MCP catalog ID this tool belongs to."),
});

const GetMcpServerToolsOutputSchema = z.object({
  tools: z
    .array(McpServerToolOutputSchema)
    .describe("Tools exposed by the selected MCP server."),
});

const SearchPrivateMcpRegistryToolArgsSchema = z
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
  .strict();

const GetMcpServerToolsToolArgsSchema = z
  .object({
    mcpServerId: UuidIdSchema.describe("The catalog ID of the MCP server."),
  })
  .strict();

const EditMcpDescriptionToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe(
      `The catalog ID of the MCP server to edit. Use ${TOOL_GET_MCP_SERVERS_SHORT_NAME} to look it up by name.`,
    ),
  })
  .merge(CatalogMetadataToolSchema.partial())
  .strict();

const EditMcpConfigToolArgsSchema = z
  .object({
    id: UuidIdSchema.describe(
      `The catalog ID of the MCP server to edit. Use ${TOOL_GET_MCP_SERVERS_SHORT_NAME} to look it up by name.`,
    ),
  })
  .merge(McpConfigToolSchema.partial())
  .strict();

const CreateMcpServerToolArgsSchema = CatalogMetadataToolSchema.extend({
  serverType: InsertInternalMcpCatalogSchema.shape.serverType
    .optional()
    .describe("Server type: local, remote, or builtin."),
})
  .merge(McpConfigToolSchema.partial())
  .strict();

const DeployMcpServerToolArgsSchema = z
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
  .strict();

const GetMcpServerLogsToolArgsSchema = z
  .object({
    serverId: UuidIdSchema.describe("The deployment ID of the MCP server."),
    lines: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Number of log lines to retrieve."),
  })
  .strict();

type SearchPrivateMcpRegistryArgs = z.infer<
  typeof SearchPrivateMcpRegistryToolArgsSchema
>;
type GetMcpServerToolsArgs = z.infer<typeof GetMcpServerToolsToolArgsSchema>;
type EditMcpDescriptionArgs = z.infer<typeof EditMcpDescriptionToolArgsSchema>;
type EditMcpConfigArgs = z.infer<typeof EditMcpConfigToolArgsSchema>;
type CreateMcpServerArgs = z.infer<typeof CreateMcpServerToolArgsSchema>;
type DeployMcpServerArgs = z.infer<typeof DeployMcpServerToolArgsSchema>;
type GetMcpServerLogsArgs = z.infer<typeof GetMcpServerLogsToolArgsSchema>;

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_SEARCH_PRIVATE_MCP_REGISTRY_SHORT_NAME,
    title: "Search Private MCP Registry",
    description:
      "Search the private MCP registry for available MCP servers. Optionally provide a search query to filter results by name or description.",
    schema: SearchPrivateMcpRegistryToolArgsSchema,
    outputSchema: SearchPrivateMcpRegistryOutputSchema,
    handler: ({ args, context }) =>
      handleSearchPrivateMcpRegistry(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_GET_MCP_SERVERS_SHORT_NAME,
    title: "Get MCP Servers",
    description: `List all MCP servers from the catalog. Use this to identify candidate MCP servers, then call ${TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME} to fetch exact tool IDs for ${TOOL_CREATE_AGENT_SHORT_NAME}/${TOOL_EDIT_AGENT_SHORT_NAME} toolAssignments.`,
    schema: EmptyToolArgsSchema,
    outputSchema: GetMcpServersOutputSchema,
    handler: ({ context }) => handleGetMcpServers(context),
  }),
  defineArchestraTool({
    shortName: TOOL_GET_MCP_SERVER_TOOLS_SHORT_NAME,
    title: "Get MCP Server Tools",
    description: `Get all tools available for a specific MCP server by its catalog ID (from ${TOOL_GET_MCP_SERVERS_SHORT_NAME}).`,
    schema: GetMcpServerToolsToolArgsSchema,
    outputSchema: GetMcpServerToolsOutputSchema,
    handler: ({ args, context }) => handleGetMcpServerTools(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_EDIT_MCP_DESCRIPTION_SHORT_NAME,
    title: "Edit MCP Server Description",
    description: `Edit an MCP server's display information and metadata. Use ${TOOL_GET_MCP_SERVERS_SHORT_NAME} to look up IDs by name. Changing scope requires admin permissions.`,
    schema: EditMcpDescriptionToolArgsSchema,
    handler: ({ args, context }) => handleEditMcpDescription(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_EDIT_MCP_CONFIG_SHORT_NAME,
    title: "Edit MCP Server Configuration",
    description: `Edit an MCP server's technical configuration. For remote servers: use serverUrl, auth, and OAuth fields. For local (K8s) servers: use command, arguments, environment, Docker, and transport fields. Local config fields are merged into the existing configuration — only specified fields are overwritten. Use ${TOOL_GET_MCP_SERVERS_SHORT_NAME} to look up IDs by name.`,
    schema: EditMcpConfigToolArgsSchema,
    handler: ({ args, context }) => handleEditMcpConfig(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_CREATE_MCP_SERVER_SHORT_NAME,
    title: "Create MCP Server",
    description:
      "Create a new MCP server in the private registry. Specify serverType to choose between local (K8s pod) or remote (HTTP URL). For local servers, provide command/arguments/environment. For remote servers, provide serverUrl and auth configuration. Defaults to personal scope.",
    schema: CreateMcpServerToolArgsSchema,
    handler: ({ args, context }) => handleCreateMcpServer(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_DEPLOY_MCP_SERVER_SHORT_NAME,
    title: "Deploy MCP Server",
    description: `Deploy (install) an MCP server from the catalog. Creates a running instance. Only works for servers that do not require authentication — if auth is needed, tells the user to install via the UI. Use ${TOOL_GET_MCP_SERVERS_SHORT_NAME} to find the catalog ID. Optionally assign the server's tools to agents.`,
    schema: DeployMcpServerToolArgsSchema,
    handler: ({ args, context }) => handleDeployMcpServer(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_MCP_SERVER_DEPLOYMENTS_SHORT_NAME,
    title: "List MCP Server Deployments",
    description:
      "List all deployed (installed) MCP server instances accessible to the current user. Shows deployment status, server type, catalog info, team, and owner.",
    schema: EmptyToolArgsSchema,
    handler: ({ context }) => handleListMcpServerDeployments(context),
  }),
  defineArchestraTool({
    shortName: TOOL_GET_MCP_SERVER_LOGS_SHORT_NAME,
    title: "Get MCP Server Logs",
    description: `Get recent container logs from a deployed local (K8s) MCP server. Use ${TOOL_LIST_MCP_SERVER_DEPLOYMENTS_SHORT_NAME} to find the server ID. Only works for local servers with K8s runtime enabled.`,
    schema: GetMcpServerLogsToolArgsSchema,
    handler: ({ args, context }) => handleGetMcpServerLogs(args, context),
  }),
  defineArchestraTool({
    shortName: TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_SHORT_NAME,
    title: "Create MCP Server Installation Request",
    description:
      "Allows users from within the Archestra Platform chat UI to submit a request for an MCP server to be added to their Archestra Platform's internal MCP server registry. This will open a dialog for the user to submit an installation request. When you trigger this tool, just tell the user to go through the dialog to submit the request. Do not provider any additional information",
    schema: EmptyToolArgsSchema,
    handler: ({ context }) => handleCreateMcpServerInstallationRequest(context),
  }),
] as const);

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const toolOutputSchemas = registry.toolOutputSchemas;
export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;

async function handleSearchPrivateMcpRegistry(
  args: SearchPrivateMcpRegistryArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;
  logger.info(
    { agentId: contextAgent.id, searchArgs: args },
    "search_private_mcp_registry tool called",
  );

  try {
    const query = args.query;

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
      return structuredSuccessResult(
        { items: [] },
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

    const output = {
      items: catalogItems.map((item) => ({
        id: item.id,
        name: item.name,
        version: item.version ?? null,
        description: item.description ?? null,
        serverType: item.serverType,
        serverUrl: item.serverUrl ?? null,
        repository: item.repository ?? null,
      })),
    };

    return structuredSuccessResult(
      output,
      `Found ${catalogItems.length} MCP server(s):\n\n${formattedResults}`,
    );
  } catch (error) {
    return catchError(error, "searching private MCP registry");
  }
}

async function handleGetMcpServers(
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info({ agentId: contextAgent.id }, "get_mcp_servers tool called");

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

    return structuredSuccessResult({ items }, JSON.stringify(items, null, 2));
  } catch (error) {
    return catchError(error, "getting MCP servers");
  }
}

async function handleGetMcpServerTools(
  args: GetMcpServerToolsArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id, mcpServerId: args.mcpServerId },
    "get_mcp_server_tools tool called",
  );

  try {
    const tools = await ToolModel.findByCatalogId(args.mcpServerId);
    return structuredSuccessResult({ tools }, JSON.stringify(tools, null, 2));
  } catch (error) {
    return catchError(error, "getting MCP server tools");
  }
}

async function handleEditMcpDescription(
  args: EditMcpDescriptionArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent, organizationId } = context;

  logger.info(
    { agentId: contextAgent.id, editArgs: args },
    "edit_mcp_description tool called",
  );

  try {
    if (!context.userId || !organizationId) {
      return errorResult("user/organization context not available.");
    }

    const existing = await InternalMcpCatalogModel.findById(args.id);
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
        return errorResult("you can only edit your own personal MCP servers.");
      }
    }

    if (args.scope !== undefined && args.scope !== existing.scope && !isAdmin) {
      return errorResult("only admins can change MCP server scope.");
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
      if (args[field] !== undefined) {
        updateData[field] = args[field];
      }
    }

    if (Object.keys(updateData).length === 0) {
      return errorResult(
        `No fields to update. Provide at least one of: ${descriptionFields.join(", ")}.`,
      );
    }

    const validatedUpdate =
      PartialUpdateInternalMcpCatalogSchema.parse(updateData);
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

async function handleEditMcpConfig(
  args: EditMcpConfigArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent, organizationId } = context;

  logger.info(
    { agentId: contextAgent.id, editArgs: args },
    "edit_mcp_config tool called",
  );

  try {
    if (!context.userId || !organizationId) {
      return errorResult("user/organization context not available.");
    }

    const existing = await InternalMcpCatalogModel.findById(args.id);
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
        return errorResult("you can only edit your own personal MCP servers.");
      }
    }

    const updateData: Record<string, unknown> = {};
    if (args.serverType !== undefined) updateData.serverType = args.serverType;
    if (args.serverUrl !== undefined) updateData.serverUrl = args.serverUrl;
    if (args.requiresAuth !== undefined)
      updateData.requiresAuth = args.requiresAuth;
    if (args.authDescription !== undefined) {
      updateData.authDescription = args.authDescription;
    }
    if (args.authFields !== undefined) updateData.authFields = args.authFields;
    if (args.oauthConfig !== undefined)
      updateData.oauthConfig = args.oauthConfig;

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
      if (args[field] !== undefined) {
        localConfigUpdates[field] = args[field];
      }
    }
    if (Object.keys(localConfigUpdates).length > 0) {
      updateData.localConfig = {
        ...(existing.localConfig ?? {}),
        ...localConfigUpdates,
      };
    }

    if (args.deploymentSpecYaml !== undefined) {
      updateData.deploymentSpecYaml = args.deploymentSpecYaml;
    }
    if (args.installationCommand !== undefined) {
      updateData.installationCommand = args.installationCommand;
    }
    if (args.userConfig !== undefined) updateData.userConfig = args.userConfig;

    if (Object.keys(updateData).length === 0) {
      return errorResult(
        "No fields to update. Provide at least one configuration field.",
      );
    }

    const validatedUpdate =
      PartialUpdateInternalMcpCatalogSchema.parse(updateData);
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
    if (updated.installationCommand) {
      lines.push(`Installation Command: ${updated.installationCommand}`);
    }
    if (updated.localConfig) {
      lines.push(`Local Config: ${JSON.stringify(updated.localConfig)}`);
    }
    if (updated.deploymentSpecYaml) {
      lines.push("Deployment Spec: (custom YAML set)");
    }

    return successResult(lines.join("\n"));
  } catch (error) {
    return catchError(error, "editing MCP server config");
  }
}

async function handleCreateMcpServer(
  args: CreateMcpServerArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent, organizationId } = context;

  logger.info(
    { agentId: contextAgent.id, createArgs: args },
    "create_mcp_server tool called",
  );

  try {
    const name = args.name;
    if (!name || name.trim() === "") {
      return errorResult("MCP server name is required and cannot be empty.");
    }

    if (!context.userId || !organizationId) {
      return errorResult("user/organization context not available.");
    }

    const serverType = args.serverType ?? "local";
    if (!["local", "remote", "builtin"].includes(serverType)) {
      return errorResult("serverType must be one of: local, remote, builtin.");
    }

    const teams = args.teams ?? [];
    const labels = args.labels ? deduplicateLabels(args.labels) : undefined;
    const scope = args.scope ?? (teams.length > 0 ? "team" : "personal");

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
      if (args[field] !== undefined) {
        localConfig[field] = args[field];
      }
    }

    const createParams: Record<string, unknown> = {
      name,
      serverType: serverType as "local" | "remote" | "builtin",
      scope,
    };
    if (args.description !== undefined)
      createParams.description = args.description;
    if (args.icon !== undefined) createParams.icon = args.icon;
    if (args.docsUrl !== undefined) createParams.docsUrl = args.docsUrl;
    if (args.repository !== undefined)
      createParams.repository = args.repository;
    if (args.version !== undefined) createParams.version = args.version;
    if (args.instructions !== undefined) {
      createParams.instructions = args.instructions;
    }
    if (args.serverUrl !== undefined) createParams.serverUrl = args.serverUrl;
    if (args.requiresAuth !== undefined)
      createParams.requiresAuth = args.requiresAuth;
    if (args.authDescription !== undefined) {
      createParams.authDescription = args.authDescription;
    }
    if (args.authFields !== undefined)
      createParams.authFields = args.authFields;
    if (args.oauthConfig !== undefined)
      createParams.oauthConfig = args.oauthConfig;
    if (Object.keys(localConfig).length > 0)
      createParams.localConfig = localConfig;
    if (args.deploymentSpecYaml !== undefined) {
      createParams.deploymentSpecYaml = args.deploymentSpecYaml;
    }
    if (args.installationCommand !== undefined) {
      createParams.installationCommand = args.installationCommand;
    }
    if (args.userConfig !== undefined)
      createParams.userConfig = args.userConfig;
    if (labels) createParams.labels = labels;
    if (teams.length > 0) createParams.teams = teams;

    const validatedParams = InsertInternalMcpCatalogSchema.parse(createParams);
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
    if (created.description) lines.push(`Description: ${created.description}`);
    if (created.serverUrl) lines.push(`Server URL: ${created.serverUrl}`);
    if (created.localConfig) {
      lines.push(`Local Config: ${JSON.stringify(created.localConfig)}`);
    }
    if (created.teams.length > 0) {
      lines.push(`Teams: ${created.teams.map((t) => t.name).join(", ")}`);
    }
    if (created.labels.length > 0) {
      lines.push(
        `Labels: ${created.labels.map((l) => `${l.key}: ${l.value}`).join(", ")}`,
      );
    }

    return successResult(lines.join("\n"));
  } catch (error) {
    return catchError(error, "creating MCP server");
  }
}

async function handleDeployMcpServer(
  args: DeployMcpServerArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent, organizationId } = context;

  logger.info(
    { agentId: contextAgent.id, deployArgs: args },
    "deploy_mcp_server tool called",
  );

  try {
    if (!context.userId || !organizationId) {
      return errorResult("user/organization context not available.");
    }

    const catalogItem = await InternalMcpCatalogModel.findById(args.catalogId);
    if (!catalogItem) {
      return errorResult("catalog item not found.");
    }

    if (catalogItem.requiresAuth || catalogItem.oauthConfig) {
      return errorResult(
        "This MCP server requires authentication. Please install it through the UI at /mcp/registry where you can provide credentials.",
      );
    }

    const requiredPromptedEnvVars =
      catalogItem.localConfig?.environment?.filter(
        (env) => env.promptOnInstallation && env.required,
      ) ?? [];
    if (requiredPromptedEnvVars.length > 0) {
      return errorResult(
        `This MCP server requires environment variables to be provided during installation: ${requiredPromptedEnvVars.map((e) => e.key).join(", ")}. Please install it through the UI at /mcp/registry.`,
      );
    }

    const teamId = args.teamId;
    const existingServers = await McpServerModel.findByCatalogId(
      args.catalogId,
    );
    if (!teamId) {
      const existingPersonal = existingServers.find(
        (server) => server.ownerId === context.userId && !server.teamId,
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
      const existingTeam = existingServers.find(
        (server) => server.teamId === teamId,
      );
      if (existingTeam) {
        return errorResult(
          "This team already has an installation of this MCP server.",
        );
      }
    }

    const mcpServer = await McpServerModel.create({
      name: catalogItem.name,
      catalogId: args.catalogId,
      serverType: catalogItem.serverType,
      ownerId: context.userId,
      userId: context.userId,
      ...(teamId && { teamId }),
    });

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

      void discoverLocalMcpServerTools({
        args,
        mcpServer,
        catalogItem,
      });
    }

    if (catalogItem.serverType === "remote") {
      await discoverRemoteMcpServerTools({
        args,
        mcpServer,
        catalogItem,
      });
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

async function handleListMcpServerDeployments(
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent, organizationId } = context;

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
      if (server.localInstallationError) {
        lines.push(`  Error: ${server.localInstallationError}`);
      }
      if (server.teamDetails) lines.push(`  Team: ${server.teamDetails.name}`);
      if (server.ownerEmail) lines.push(`  Owner: ${server.ownerEmail}`);
      lines.push("");
    }

    return successResult(lines.join("\n"));
  } catch (error) {
    return catchError(error, "listing MCP server deployments");
  }
}

async function handleGetMcpServerLogs(
  args: GetMcpServerLogsArgs,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent, organizationId } = context;

  logger.info(
    { agentId: contextAgent.id, logsArgs: args },
    "get_mcp_server_logs tool called",
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
    const server = await McpServerModel.findById(
      args.serverId,
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
      return errorResult("K8s runtime is not available. Cannot retrieve logs.");
    }

    const lineCount = args.lines ?? 100;
    const logsResult = await McpServerRuntimeManager.getMcpServerLogs(
      args.serverId,
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

async function handleCreateMcpServerInstallationRequest(
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent } = context;

  logger.info(
    { agentId: contextAgent.id },
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

async function discoverLocalMcpServerTools(params: {
  args: DeployMcpServerArgs;
  mcpServer: Awaited<ReturnType<typeof McpServerModel.create>>;
  catalogItem: Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>> & {
    id: string;
    name: string;
  };
}): Promise<void> {
  const { args, mcpServer, catalogItem } = params;

  try {
    const k8sDeployment = await McpServerRuntimeManager.getOrLoadDeployment(
      mcpServer.id,
    );
    if (!k8sDeployment) {
      throw new Error("Deployment manager not found");
    }

    await k8sDeployment.waitForDeploymentReady(60, 2000);
    await McpServerModel.update(mcpServer.id, {
      localInstallationStatus: "discovering-tools",
      localInstallationError: null,
    });

    const discoveredTools = await McpServerModel.getToolsFromServer(mcpServer);
    const toolsToCreate = discoveredTools.map((tool) => ({
      name: ToolModel.slugifyName(
        catalogItem.name || mcpServer.name,
        tool.name,
      ),
      description: tool.description,
      parameters: tool.inputSchema,
      catalogId: catalogItem.id,
    }));

    if (toolsToCreate.length > 0) {
      const createdTools =
        await ToolModel.bulkCreateToolsIfNotExists(toolsToCreate);
      await assignDiscoveredToolsToAgents({
        agentIds: args.agentIds ?? [],
        toolIds: createdTools.map((tool) => tool.id),
        mcpServerId: mcpServer.id,
      });
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
}

async function discoverRemoteMcpServerTools(params: {
  args: DeployMcpServerArgs;
  mcpServer: Awaited<ReturnType<typeof McpServerModel.create>>;
  catalogItem: Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>> & {
    id: string;
    name: string;
  };
}): Promise<void> {
  const { args, mcpServer, catalogItem } = params;

  try {
    const discoveredTools = await McpServerModel.getToolsFromServer(mcpServer);
    if (discoveredTools.length === 0) {
      return;
    }

    const toolsToCreate = discoveredTools.map((tool) => ({
      name: ToolModel.slugifyName(catalogItem.name, tool.name),
      description: tool.description,
      parameters: tool.inputSchema,
      catalogId: catalogItem.id,
    }));
    const createdTools =
      await ToolModel.bulkCreateToolsIfNotExists(toolsToCreate);
    await assignDiscoveredToolsToAgents({
      agentIds: args.agentIds ?? [],
      toolIds: createdTools.map((tool) => tool.id),
      mcpServerId: mcpServer.id,
    });
  } catch (err) {
    logger.error(
      { err, mcpServerId: mcpServer.id },
      "Error fetching tools from remote server",
    );
  }
}

async function assignDiscoveredToolsToAgents(params: {
  agentIds: string[];
  toolIds: string[];
  mcpServerId: string;
}): Promise<void> {
  const { agentIds, toolIds, mcpServerId } = params;

  if (agentIds.length === 0 || toolIds.length === 0) {
    return;
  }

  await AgentToolModel.bulkCreateForAgentsAndTools(agentIds, toolIds, {
    mcpServerId,
  });
}
