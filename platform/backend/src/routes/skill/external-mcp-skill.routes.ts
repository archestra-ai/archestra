import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getMcpCatalogPermissionChecker } from "@/auth/mcp-catalog-permissions";
import config from "@/config";
import { AgentModel, ExternalMcpSkillUsageEventModel } from "@/models";
import {
  canReadExternalMcpSkillUsage,
  getExternalMcpSkill,
  listExternalMcpSkills,
} from "@/services/external-mcp-skills";
import {
  ApiError,
  agentOwner,
  constructResponseSchema,
  ExternalMcpSkillDetailSchema,
  ExternalMcpSkillListItemSchema,
  SkillUsageStatisticsSchema,
  UuidIdSchema,
} from "@/types";

const USAGE_STATISTICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const externalMcpSkillRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/skills/external",
    {
      schema: {
        operationId: RouteId.GetExternalMcpSkills,
        description:
          "List Skills dynamically projected from the caller's accessible MCP server installations.",
        tags: ["Skills"],
        querystring: z.object({ environmentId: UuidIdSchema.optional() }),
        response: constructResponseSchema(
          z.array(ExternalMcpSkillListItemSchema),
        ),
      },
    },
    async ({ user, organizationId, query }, reply) => {
      assertEnabled();
      const { isAdmin: isMcpServerAdmin } =
        await getMcpCatalogPermissionChecker({
          userId: user.id,
          organizationId,
        });
      return reply.send(
        await listExternalMcpSkills({
          userId: user.id,
          organizationId,
          isMcpServerAdmin,
          environmentId: query.environmentId,
        }),
      );
    },
  );

  fastify.get(
    "/api/skills/external/usage-statistics",
    {
      schema: {
        operationId: RouteId.GetExternalMcpSkillUsageStatistics,
        description:
          "Get recent activation statistics for one external MCP Skill from an accessible installation.",
        tags: ["Skills"],
        querystring: z.object({
          mcpServerId: UuidIdSchema,
          uri: z.string().min(1),
        }),
        response: constructResponseSchema(SkillUsageStatisticsSchema),
      },
    },
    async ({ query, user, organizationId }, reply) => {
      assertEnabled();
      const { isAdmin: isMcpServerAdmin } =
        await getMcpCatalogPermissionChecker({
          userId: user.id,
          organizationId,
        });
      const canRead = await canReadExternalMcpSkillUsage({
        mcpServerId: query.mcpServerId,
        uri: query.uri,
        userId: user.id,
        organizationId,
        isMcpServerAdmin,
      });
      if (!canRead) throw new ApiError(404, "External skill not found");

      return reply.send(
        await ExternalMcpSkillUsageEventModel.getUsageStatistics({
          mcpServerId: query.mcpServerId,
          uri: query.uri,
          since: new Date(Date.now() - USAGE_STATISTICS_WINDOW_MS),
        }),
      );
    },
  );

  fastify.get(
    "/api/skills/external/:id",
    {
      schema: {
        operationId: RouteId.GetExternalMcpSkill,
        description:
          "Fetch and digest-verify the current bytes of an external MCP Skill from one accessible installation.",
        tags: ["Skills"],
        params: z.object({ id: UuidIdSchema }),
        querystring: z.object({ mcpServerId: UuidIdSchema }),
        response: constructResponseSchema(ExternalMcpSkillDetailSchema),
      },
    },
    async ({ params, query, user, organizationId }, reply) => {
      assertEnabled();
      const { isAdmin: isMcpServerAdmin } =
        await getMcpCatalogPermissionChecker({
          userId: user.id,
          organizationId,
        });
      const personalGateway = await AgentModel.getPersonalMcpGateway(
        user.id,
        organizationId,
      );
      const skill = await getExternalMcpSkill({
        id: params.id,
        mcpServerId: query.mcpServerId,
        userId: user.id,
        organizationId,
        isMcpServerAdmin,
        owner: personalGateway ? agentOwner(personalGateway.id) : undefined,
        tokenAuth: {
          tokenId: `session:${user.id}`,
          teamId: null,
          isOrganizationToken: false,
          organizationId,
          isUserToken: true,
          userId: user.id,
          isSessionAuth: true,
        },
      });
      if (!skill) throw new ApiError(404, "External skill not found");
      return reply.send(skill);
    },
  );
};

function assertEnabled(): void {
  if (!config.mcpGateway.skillsEnabled) {
    throw new ApiError(404, "Skills over MCP is not enabled");
  }
}

export default externalMcpSkillRoutes;
