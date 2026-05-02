import {
  AGENT_TEMPLATES,
  ARCHESTRA_MCP_CATALOG_ID,
  ARCHESTRA_MCP_SERVER_NAME,
  archestraCatalogSdk,
  type archestraCatalogTypes,
  getAgentTemplateById,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  OAuthConfigSchema,
  RouteId,
  TOOL_WILDCARD,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { InternalMcpCatalogModel, McpServerModel, ToolModel } from "@/models";
import type { UserConfigField } from "@/types";
import {
  AgentTemplateRequirementsSchema,
  AgentTemplateSchema,
  ApiError,
  constructResponseSchema,
} from "@/types";

const agentTemplateRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agent_templates",
    {
      schema: {
        operationId: RouteId.GetAgentTemplates,
        description: "List all pre-built agent templates",
        tags: ["Agent Templates"],
        response: constructResponseSchema(z.array(AgentTemplateSchema)),
      },
    },
    async (_request, reply) => {
      return reply.send(AGENT_TEMPLATES);
    },
  );

  fastify.get(
    "/api/agent_templates/:id/requirements",
    {
      schema: {
        operationId: RouteId.GetAgentTemplateRequirements,
        description:
          "Resolve tool IDs and check installation requirements for a template",
        tags: ["Agent Templates"],
        params: z.object({
          id: z.string().min(1),
        }),
        response: constructResponseSchema(AgentTemplateRequirementsSchema),
      },
    },
    async ({ params: { id }, user, headers, organizationId }, reply) => {
      const template = getAgentTemplateById(id);
      if (!template) {
        throw new ApiError(404, `Agent template "${id}" not found`);
      }

      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        headers,
      );
      const installedServers = await McpServerModel.findAll(
        user.id,
        isMcpServerAdmin,
      );
      const accessibleCatalogs = await InternalMcpCatalogModel.findAll({
        expandSecrets: false,
        userId: user.id,
        isAdmin: isMcpServerAdmin,
      });
      const catalogCache = new Map<
        string,
        Awaited<ReturnType<typeof resolveCatalogByServerName>>
      >();
      const toolCache = new Map<
        string,
        Awaited<ReturnType<typeof ToolModel.findByCatalogId>>
      >();
      const toolByNameCache = new Map<
        string,
        Awaited<ReturnType<typeof ToolModel.findByName>>
      >();
      const toolAssignments: Array<{
        toolId: string;
        catalogId: string | null;
        credentialResolutionMode?: "static" | "dynamic" | "enterprise_managed";
        requiresUserConfig: boolean;
      }> = [];
      const unavailableTools: Array<{
        toolName: string;
        serverName: string;
        reason: "catalog_not_found" | "tool_not_found" | "invalid_tool_name";
      }> = [];
      const missingCatalogs = new Map<
        string,
        {
          catalogId: string;
          catalogName: string;
          serverType: "local" | "remote";
          requiresOauth: boolean;
          userConfigFields: Array<
            ReturnType<typeof buildUserConfigFields>[number]
          >;
          environmentFields: Array<
            ReturnType<typeof buildEnvironmentFields>[number]
          >;
          canAutoInstall: boolean;
        }
      >();

      for (const toolFqn of template.tools) {
        const parsed = parseFqn(toolFqn);
        if (!parsed) {
          unavailableTools.push({
            toolName: toolFqn,
            serverName: "",
            reason: "invalid_tool_name",
          });
          continue;
        }

        const catalog = await getCatalogForServerName({
          serverName: parsed.serverName,
          accessibleCatalogs,
          organizationId,
          catalogCache,
        });
        if (!catalog) {
          unavailableTools.push({
            toolName: toolFqn,
            serverName: parsed.serverName,
            reason: "catalog_not_found",
          });
          continue;
        }

        const hasInstalledServer =
          catalog.id !== ARCHESTRA_MCP_CATALOG_ID &&
          catalog.serverType !== "builtin" &&
          installedServers.some((server) => server.catalogId === catalog.id);
        const needsInstallation =
          catalog.id !== ARCHESTRA_MCP_CATALOG_ID &&
          catalog.serverType !== "builtin" &&
          !hasInstalledServer;

        if (needsInstallation && !missingCatalogs.has(catalog.id)) {
          const serverType = catalog.serverType;
          if (serverType === "builtin") {
            continue;
          }
          missingCatalogs.set(catalog.id, {
            catalogId: catalog.id,
            catalogName: catalog.name,
            serverType,
            requiresOauth: Boolean(catalog.oauthConfig),
            userConfigFields: buildUserConfigFields(catalog.userConfig),
            environmentFields: buildEnvironmentFields(
              catalog.localConfig?.environment,
            ),
            canAutoInstall: canAutoInstallCatalog(catalog),
          });
        }

        const isWildcard = parsed.toolShortName === TOOL_WILDCARD;

        if (isWildcard && needsInstallation) {
          continue;
        }

        if (isWildcard) {
          const allTools = await getToolsForCatalog({
            catalogId: catalog.id,
            toolCache,
          });
          const credentialResolutionMode =
            resolveCredentialResolutionMode(catalog);
          for (const tool of allTools) {
            toolAssignments.push({
              toolId: tool.id,
              catalogId:
                catalog.id === ARCHESTRA_MCP_CATALOG_ID ? null : catalog.id,
              ...(credentialResolutionMode ? { credentialResolutionMode } : {}),
              requiresUserConfig: credentialResolutionMode === "static",
            });
          }
          continue;
        }

        const tools = await getToolsForCatalog({
          catalogId: catalog.id,
          toolCache,
        });
        const resolvedTool =
          tools.find((tool) => tool.name === toolFqn) ??
          (catalog.id.startsWith("external-template:")
            ? await getToolByName({ toolFqn, toolByNameCache })
            : null);
        if (!resolvedTool) {
          if (!needsInstallation) {
            unavailableTools.push({
              toolName: toolFqn,
              serverName: parsed.serverName,
              reason: "tool_not_found",
            });
          }
          continue;
        }

        const credentialResolutionMode =
          resolveCredentialResolutionMode(catalog);
        const requiresUserConfig = credentialResolutionMode === "static";

        toolAssignments.push({
          toolId: resolvedTool.id,
          catalogId:
            catalog.id === ARCHESTRA_MCP_CATALOG_ID ? null : catalog.id,
          ...(credentialResolutionMode ? { credentialResolutionMode } : {}),
          requiresUserConfig,
        });
      }

      return reply.send({
        templateId: template.id,
        agentConfig: {
          name: template.name,
          description: template.description,
          systemPrompt: template.systemPrompt,
          llmModel: template.llmModel,
          labels: template.labels,
          agentType: "agent",
          scope: "personal",
          teams: [],
        },
        toolAssignments,
        missingCatalogs: [...missingCatalogs.values()],
        unavailableTools,
      });
    },
  );
};

export default agentTemplateRoutes;

function parseFqn(
  fqn: string,
): { serverName: string; toolShortName: string } | null {
  const idx = fqn.lastIndexOf(MCP_SERVER_TOOL_NAME_SEPARATOR);
  if (idx <= 0) {
    return null;
  }

  return {
    serverName: fqn.slice(0, idx),
    toolShortName: fqn.slice(idx + MCP_SERVER_TOOL_NAME_SEPARATOR.length),
  };
}

async function getCatalogForServerName(params: {
  serverName: string;
  accessibleCatalogs: Awaited<
    ReturnType<typeof InternalMcpCatalogModel.findAll>
  >;
  organizationId: string;
  catalogCache: Map<
    string,
    Awaited<ReturnType<typeof resolveCatalogByServerName>>
  >;
}) {
  const cached = params.catalogCache.get(params.serverName);
  if (cached !== undefined) {
    return cached;
  }

  const catalog = await resolveCatalogByServerName({
    serverName: params.serverName,
    accessibleCatalogs: params.accessibleCatalogs,
    organizationId: params.organizationId,
  });
  params.catalogCache.set(params.serverName, catalog);
  return catalog;
}

async function getToolsForCatalog(params: {
  catalogId: string;
  toolCache: Map<string, Awaited<ReturnType<typeof ToolModel.findByCatalogId>>>;
}) {
  if (params.catalogId.startsWith("external-template:")) {
    return [];
  }

  const cached = params.toolCache.get(params.catalogId);
  if (cached) {
    return cached;
  }

  const tools = await ToolModel.findByCatalogId(params.catalogId);
  params.toolCache.set(params.catalogId, tools);
  return tools;
}

async function getToolByName(params: {
  toolFqn: string;
  toolByNameCache: Map<
    string,
    Awaited<ReturnType<typeof ToolModel.findByName>>
  >;
}) {
  const cached = params.toolByNameCache.get(params.toolFqn);
  if (cached !== undefined) {
    return cached;
  }

  const tool = await ToolModel.findByName(params.toolFqn);
  params.toolByNameCache.set(params.toolFqn, tool);
  return tool;
}

async function resolveCatalogByServerName(params: {
  serverName: string;
  accessibleCatalogs: Awaited<
    ReturnType<typeof InternalMcpCatalogModel.findAll>
  >;
  organizationId: string;
}) {
  if (params.serverName === ARCHESTRA_MCP_SERVER_NAME) {
    return {
      id: ARCHESTRA_MCP_CATALOG_ID,
      name: ARCHESTRA_MCP_SERVER_NAME,
      serverType: "builtin" as const,
      oauthConfig: null,
      enterpriseManagedConfig: null,
      userConfig: null,
      localConfig: null,
    };
  }

  const catalog =
    params.accessibleCatalogs.find(
      (catalog) =>
        catalog.name === params.serverName &&
        (!catalog.organizationId ||
          catalog.organizationId === params.organizationId),
    ) ?? null;
  if (catalog) {
    return catalog;
  }

  return previewCatalogFromExternalTemplate({
    serverName: params.serverName,
  });
}

async function previewCatalogFromExternalTemplate(params: {
  serverName: string;
}) {
  const externalName = TEMPLATE_EXTERNAL_CATALOG_NAMES[params.serverName];
  if (!externalName) {
    return null;
  }

  const response = await archestraCatalogSdk.getMcpServer({
    path: { name: externalName },
  });
  if (!response.data) {
    return null;
  }

  const external = response.data;

  const oauthConfig = buildOAuthConfigFromExternalCatalog(
    external.oauth_config,
  );

  return {
    id: `external-template:${params.serverName}`,
    name: params.serverName,
    description: external.description,
    instructions: external.instructions,
    serverType: external.server.type,
    serverUrl:
      external.server.type === "remote" ? external.server.url : undefined,
    docsUrl:
      external.server.type === "remote"
        ? (external.server.docs_url ?? undefined)
        : undefined,
    localConfig:
      external.server.type === "local"
        ? buildLocalConfigFromExternalServer(external.server)
        : null,
    userConfig: external.user_config ?? {},
    oauthConfig,
    enterpriseManagedConfig: null,
    authFields: null,
    labels: [],
    teams: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    authorId: null,
    authorName: null,
    organizationId: null,
  };
}

function buildLocalConfigFromExternalServer(
  server: Extract<
    archestraCatalogTypes.ArchestraMcpServerManifest["server"],
    { type: "local" }
  >,
) {
  return {
    command: server.command,
    arguments: server.args,
    dockerImage: server.docker_image,
    serviceAccount: server.service_account,
    environment: Object.entries(server.env ?? {}).map(([key, value]) => ({
      key,
      value,
      type: "plain_text" as const,
      promptOnInstallation: true,
    })),
  };
}

const TEMPLATE_EXTERNAL_CATALOG_NAMES: Record<string, string> = {
  github: "githubcopilot__remote-mcp",
  slack: "korotovsky__slack-mcp-server",
};

function resolveCredentialResolutionMode(catalog: {
  id: string;
  enterpriseManagedConfig?: unknown;
  userConfig?: Record<string, unknown> | null;
}) {
  if (catalog.id === ARCHESTRA_MCP_CATALOG_ID) {
    return undefined;
  }

  if (catalog.enterpriseManagedConfig) {
    return "enterprise_managed" as const;
  }

  if (catalog.userConfig && Object.keys(catalog.userConfig).length > 0) {
    return "static" as const;
  }

  return "dynamic" as const;
}

function canAutoInstallCatalog(catalog: {
  enterpriseManagedConfig?: unknown;
  oauthConfig?: unknown;
  userConfig?: Record<string, unknown> | null;
  localConfig?: {
    environment?: Array<{ promptOnInstallation?: boolean }>;
  } | null;
}) {
  if (catalog.enterpriseManagedConfig || catalog.oauthConfig) {
    return false;
  }

  if (catalog.userConfig && Object.keys(catalog.userConfig).length > 0) {
    return false;
  }

  return !catalog.localConfig?.environment?.some(
    (field) => field.promptOnInstallation !== false,
  );
}

function buildUserConfigFields(
  userConfig: Record<string, UserConfigField> | null | undefined,
) {
  return Object.entries(userConfig ?? {}).map(([key, value]) => ({
    key,
    ...value,
  }));
}

function buildEnvironmentFields(
  environment:
    | Array<{
        key: string;
        type: "plain_text" | "secret" | "boolean" | "number";
        value?: string;
        promptOnInstallation: boolean;
        required?: boolean;
        description?: string;
        default?: string | number | boolean;
        mounted?: boolean;
      }>
    | null
    | undefined,
) {
  return (environment ?? [])
    .filter((field) => field.promptOnInstallation !== false)
    .map(({ value: _value, default: _default, ...field }) => field);
}

function buildOAuthConfigFromExternalCatalog(
  oauthConfig: archestraCatalogTypes.ArchestraMcpServerManifest["oauth_config"],
) {
  if (!oauthConfig) {
    return null;
  }

  return OAuthConfigSchema.parse(oauthConfig);
}
