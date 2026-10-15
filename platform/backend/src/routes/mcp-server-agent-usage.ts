import { PaginationQuerySchema, RouteId } from "@archestra/shared";
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
import McpServerAgentUsageModel from "@/models/mcp-server-agent-usage";
import { isPredefinedAdmin } from "@/services/agent-tool-assignment";
// SPDX-SnippetEnd
import { constructResponseSchema } from "@/types";
import { McpAgentUsagePageSchema } from "@/types/mcp-server-agent-usage";

const mcpServerAgentUsageRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/mcp_server/agent_usage",
    {
      schema: {
        operationId: RouteId.GetMcpServerAgentUsage,
        description:
          "Bounded agent usage pages or group previews for requested readable MCP catalog entries.",
        tags: ["MCP Server"],
        querystring: PaginationQuerySchema.extend({
          catalogIds: z.preprocess(
            (value) => (typeof value === "string" ? value.split(",") : value),
            z.array(z.string().uuid()).min(1).max(20),
          ),
          search: z.string().max(200).optional(),
          sortDirection: z.enum(["asc", "desc"]).default("asc"),
          previews: z.enum(["true", "false"]).default("false"),
        }),
        response: constructResponseSchema(z.array(McpAgentUsagePageSchema)),
      },
    },
    async ({ user, organizationId, query }) => {
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      const context = { userId: user.id, organizationId };
      const [installationAdmin, predefinedAdmin, managesInstalls, agentAdmin] =
        await Promise.all([
          isMcpInstallationAdmin(context),
          isPredefinedAdmin(context),
          userHasPermission(
            user.id,
            organizationId,
            "mcpServerInstallation",
            "update",
          ),
          hasAnyAgentTypeAdminPermission(context),
        ]);
      const catalogs = await InternalMcpCatalogModel.findAccessibleIds({
        userId: user.id,
        organizationId,
        isAdmin: installationAdmin,
      });
      const allowed = new Set(catalogs);
      const catalogIds = [...new Set(query.catalogIds)].filter((id) =>
        allowed.has(id),
      );
      if (!catalogIds.length) return [];
      const [servers, visibleAgentIds] = await Promise.all([
        McpServerModel.findAll(
          user.id,
          installationAdmin,
          organizationId,
          undefined,
          predefinedAdmin,
          {
            catalogIds,
            includeAssignedAgents: false,
            excludeServerTypes: ["app"],
          },
        ),
        managesInstalls || agentAdmin
          ? undefined
          : AgentTeamModel.getUserAccessibleAgentIds(user.id, false),
      ]);
      // SPDX-SnippetEnd
      return McpServerAgentUsageModel.find({
        ...query,
        catalogIds,
        organizationId,
        serverIds: servers.map((server) => server.id),
        visibleAgentIds,
        previews: query.previews === "true",
      });
    },
  );
};

export default mcpServerAgentUsageRoutes;
