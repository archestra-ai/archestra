import { CursorQuerySchema, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { userHasPermission } from "@/auth";
import { hasAnyAgentTypeAdminPermission } from "@/auth/agent-type-permissions";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import AgentTeamModel from "@/models/agent-team";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
// SPDX-SnippetEnd
import McpServerAgentUsageModel from "@/models/mcp-server-agent-usage";
import { isPredefinedAdmin } from "@/services/agent-tool-assignment";
import { ApiError, constructResponseSchema } from "@/types";
import { McpAutoModeAgentPageSchema } from "@/types/mcp-server-agent-usage";

const mcpServerAgentUsageRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/mcp_server/auto_mode_agents/page",
    {
      schema: {
        operationId: RouteId.GetMcpServerAutoModeAgentPage,
        description:
          "Count visible automatic agents or fetch a bounded cursor page, optionally excluding explicit assignments to a readable catalog.",
        tags: ["MCP Server"],
        querystring: CursorQuerySchema.extend({
          catalogId: z.string().uuid().optional(),
          afterAgentId: z.string().uuid().optional(),
          search: z.string().max(200).optional(),
          sortDirection: z.enum(["asc", "desc"]).default("asc"),
          summary: z.enum(["true", "false"]).default("false"),
        }),
        response: constructResponseSchema(McpAutoModeAgentPageSchema),
      },
    },
    async ({ user, organizationId, query }) => {
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      const context = { userId: user.id, organizationId };
      const [managesInstalls, agentAdmin] = await Promise.all([
        userHasPermission(
          user.id,
          organizationId,
          "mcpServerInstallation",
          "update",
        ),
        hasAnyAgentTypeAdminPermission(context),
      ]);
      const visibleAgentIds =
        managesInstalls || agentAdmin
          ? undefined
          : await AgentTeamModel.getUserAccessibleAgentIds(user.id, false);
      let serverIds: string[] = [];
      if (query.catalogId) {
        const [installationAdmin, predefinedAdmin] = await Promise.all([
          isMcpInstallationAdmin(context),
          isPredefinedAdmin(context),
        ]);
        const catalogs = await InternalMcpCatalogModel.findAccessibleIds({
          ...context,
          isAdmin: installationAdmin,
        });
        if (!catalogs.includes(query.catalogId))
          throw new ApiError(404, "Catalog entry not found");
        const servers = await McpServerModel.findAll(
          user.id,
          installationAdmin,
          organizationId,
          undefined,
          predefinedAdmin,
          {
            catalogId: query.catalogId,
            includeAssignedAgents: false,
            excludeServerTypes: ["app"],
          },
        );
        serverIds = servers.map((server) => server.id);
      }
      // SPDX-SnippetEnd
      const params = { ...query, organizationId, visibleAgentIds, serverIds };
      if (query.summary === "true")
        return {
          data: [],
          pagination: { limit: query.limit, hasNext: false, nextCursor: null },
          totalAutoCount: await McpServerAgentUsageModel.count(params),
          organizationId,
        };
      return McpServerAgentUsageModel.find(params);
    },
  );
};

export default mcpServerAgentUsageRoutes;
