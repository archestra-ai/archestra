import {
  AGENT_TEMPLATES,
  getAgentTemplateById,
  parseFullToolName,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAgentTypePermissionChecker } from "@/auth";
import logger from "@/logging";
import { InternalMcpCatalogModel, McpServerModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";

const AgentTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.string(),
  categories: z.array(z.string()),
  systemPrompt: z.string(),
  llmModel: z.string().nullable(),
  tools: z.array(z.string()),
  labels: z.array(z.object({ key: z.string(), value: z.string() })),
  icon: z.string().nullable().optional(),
});

const InstallRequirementFieldSchema = z.object({
  key: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  type: z.string(),
  required: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  default: z.unknown().optional(),
});

const AgentTemplateInstallRequirementsSchema = z.object({
  templateId: z.string(),
  missingCatalogIds: z.array(z.string()),
  missingCatalogs: z.array(
    z.object({
      catalogId: z.string(),
      catalogName: z.string(),
      serverType: z.string(),
      requiresOauth: z.boolean(),
      userConfigFields: z.array(InstallRequirementFieldSchema),
      environmentFields: z.array(
        InstallRequirementFieldSchema.extend({
          mounted: z.boolean().optional(),
        }),
      ),
    }),
  ),
});

const agentTemplateRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agent_templates",
    {
      schema: {
        operationId: RouteId.GetAgentTemplates,
        description: "Get available agent templates (code-defined)",
        tags: ["Agent Templates"],
        response: constructResponseSchema(z.array(AgentTemplateSchema)),
      },
    },
    async ({ user, organizationId }, reply) => {
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      const agentType = "agent" as const;
      checker.require(agentType, "create");

      return reply.send(AGENT_TEMPLATES);
    },
  );

  fastify.get(
    "/api/agent_templates/:id/requirements",
    {
      schema: {
        operationId: RouteId.GetAgentTemplateInstallRequirements,
        description: "Get required MCP install inputs to use an agent template",
        tags: ["Agent Templates"],
        params: z.object({ id: z.string().min(1) }),
        response: constructResponseSchema(
          AgentTemplateInstallRequirementsSchema,
        ),
      },
    },
    async ({ user, organizationId, params }, reply) => {
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      const agentType = "agent" as const;
      checker.require(agentType, "create");

      const template = getAgentTemplateById(params.id);
      if (!template) {
        throw new ApiError(404, "Agent template not found");
      }

      const catalogIds =
        (await getCatalogIdsForTemplateTools(template.tools)) ?? [];
      if (catalogIds.length === 0) {
        return reply.send({
          templateId: template.id,
          missingCatalogIds: [],
          missingCatalogs: [],
        });
      }

      const accessibleServers = await McpServerModel.findAll(user.id, false);
      const accessibleCatalogIdSet = new Set(
        accessibleServers.map((s) => s.catalogId).filter(Boolean),
      );
      const missingCatalogIds = catalogIds.filter(
        (catalogId) => !accessibleCatalogIdSet.has(catalogId),
      );

      const missingCatalogs = [];
      for (const catalogId of missingCatalogIds) {
        const item = await InternalMcpCatalogModel.findById(catalogId);
        if (!item) continue;

        const userConfigFields = Object.entries(item.userConfig ?? {})
          .filter(([, field]) => field.promptOnInstallation === true)
          .map(([key, field]) => ({
            key,
            title: field.title,
            description: field.description,
            type: field.type,
            required: field.required,
            sensitive: field.sensitive,
            default: field.default,
          }));

        const environmentFields =
          item.localConfig?.environment
            ?.filter((env) => env.promptOnInstallation === true)
            .map((env) => ({
              key: env.key,
              title: env.key,
              description: env.description,
              type: env.type,
              required: env.required,
              sensitive: env.type === "secret",
              default: env.default,
              mounted: env.mounted,
            })) ?? [];

        missingCatalogs.push({
          catalogId: item.id,
          catalogName: item.name,
          serverType: item.serverType,
          requiresOauth: !!item.oauthConfig,
          userConfigFields,
          environmentFields,
        });
      }

      logger.info(
        {
          userId: user.id,
          organizationId,
          agentTemplateId: template.id,
          resolvedCatalogCount: catalogIds.length,
          missingCatalogCount: missingCatalogIds.length,
          missingCatalogIds,
        },
        "Computed agent template MCP install requirements",
      );

      return reply.send({
        templateId: template.id,
        missingCatalogIds,
        missingCatalogs,
      });
    },
  );
};

export default agentTemplateRoutes;

async function getCatalogIdsForTemplateTools(
  toolFullNames: string[] | undefined,
): Promise<string[] | null> {
  if (!toolFullNames || toolFullNames.length === 0) return null;

  const serverNameSet = new Set<string>();
  for (const fullName of toolFullNames) {
    const parsed = parseFullToolName(fullName);
    if (parsed.serverName) serverNameSet.add(parsed.serverName);
  }
  if (serverNameSet.size === 0) return [];

  const catalogIds: string[] = [];
  for (const serverName of serverNameSet) {
    const catalogItem = await InternalMcpCatalogModel.findByName(serverName);
    if (!catalogItem) {
      logger.warn(
        { serverName },
        "Agent template tool assignments reference unknown MCP catalog name",
      );
      continue;
    }
    catalogIds.push(catalogItem.id);
  }

  return catalogIds;
}
