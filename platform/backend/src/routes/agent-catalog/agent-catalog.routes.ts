import {
  calculatePaginationMeta,
  PaginationQuerySchema,
  parseLabelsParam,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAgentTypePermissionChecker, userHasPermission } from "@/auth";
import { AgentModel } from "@/models";
import { listA2aRemoteAgents } from "@/services/a2a-outbound-registry";
import { populateAgentListActivationSkillCounts } from "@/services/agent-list";
import {
  AgentCatalogResponseSchema,
  type AgentCatalogRow,
  AgentScopeFilterSchema,
  constructResponseSchema,
  createSortingQuerySchema,
} from "@/types";

const agentCatalogRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agent-catalog",
    {
      schema: {
        operationId: RouteId.GetAgentCatalog,
        description:
          "List internal and external A2A agents for the Agents page.",
        tags: ["Agents"],
        querystring: z
          .object({
            name: z.string().optional(),
            scope: AgentScopeFilterSchema.optional(),
            teamIds: z
              .preprocess(
                (value) =>
                  typeof value === "string" ? value.split(",") : value,
                z.array(z.string()),
              )
              .optional(),
            authorIds: z
              .preprocess(
                (value) =>
                  typeof value === "string" ? value.split(",") : value,
                z.array(z.string()),
              )
              .optional(),
            excludeAuthorIds: z
              .preprocess(
                (value) =>
                  typeof value === "string" ? value.split(",") : value,
                z.array(z.string()),
              )
              .optional(),
            excludeOtherPersonalAgents: z
              .preprocess(
                (value) =>
                  typeof value === "string" ? value === "true" : value,
                z.boolean(),
              )
              .optional(),
            selectableOnly: z
              .preprocess(
                (value) =>
                  typeof value === "string" ? value === "true" : value,
                z.boolean(),
              )
              .describe(
                "When true, omit external A2A agents unless the caller can manage external-agent settings. Used to enumerate rows for bulk selection on the Agents page.",
              )
              .optional(),
            labels: z.string().optional(),
            status: z.enum(["active", "deleted"]).optional(),
            providerApiKeyId: z
              .union([z.string().uuid(), z.literal("organization-default")])
              .optional(),
          })
          .merge(PaginationQuerySchema)
          .merge(
            createSortingQuerySchema(["name", "createdAt", "team"] as const),
          ),
        response: constructResponseSchema(AgentCatalogResponseSchema),
      },
    },
    async ({ organizationId, user, query }, reply) => {
      const checker = await getAgentTypePermissionChecker({
        userId: user.id,
        organizationId,
      });
      checker.require("agent", query.status === "deleted" ? "delete" : "read");
      const isAgentAdmin = checker.isAdmin("agent");
      const canManageExternalAgents = await userHasPermission(
        user.id,
        organizationId,
        "agentSettings",
        "update",
      );
      const filters = {
        organizationId,
        name: query.name,
        scope: query.scope,
        teamIds: query.teamIds,
        authorIds: isAgentAdmin ? query.authorIds : undefined,
        excludeAuthorIds: isAgentAdmin ? query.excludeAuthorIds : undefined,
        excludeOtherPersonalAgents: isAgentAdmin
          ? query.excludeOtherPersonalAgents
          : undefined,
        labels: parseLabelsParam(query.labels),
        status: query.status,
        providerApiKeyId: query.providerApiKeyId,
      };
      const sorting = {
        sortBy: query.sortBy,
        sortDirection: query.sortDirection,
      };
      const candidates = await AgentModel.findCatalogCandidates({
        pagination: { limit: query.limit, offset: query.offset },
        sorting,
        filters,
        userId: user.id,
        isAgentAdmin,
        canManageExternalAgents,
        includeExternalAgents: !query.selectableOnly || canManageExternalAgents,
        excludeOtherPersonalExternalAgents: query.excludeOtherPersonalAgents,
      });
      const agentIds = candidates.rows.flatMap((row) =>
        row.type === "agent" ? [row.id] : [],
      );
      const externalAgentIds = candidates.rows.flatMap((row) =>
        row.type === "external" ? [row.id] : [],
      );
      const [agents, externalAgents] = await Promise.all([
        agentIds.length > 0
          ? AgentModel.findAllPaginated(
              { limit: agentIds.length, offset: 0 },
              sorting,
              { ...filters, ids: agentIds, agentTypes: ["agent"] },
              user.id,
              isAgentAdmin,
            ).then((result) => result.data)
          : Promise.resolve([]),
        listA2aRemoteAgents({
          organizationId,
          userId: user.id,
          canManage: canManageExternalAgents,
          ids: externalAgentIds,
        }),
      ]);
      await populateAgentListActivationSkillCounts({
        agents,
        organizationId,
        userId: user.id,
      });
      const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
      const externalAgentsById = new Map(
        externalAgents.map((agent) => [agent.id, agent]),
      );
      const data: AgentCatalogRow[] = [];
      for (const row of candidates.rows) {
        if (row.type === "agent") {
          const agent = agentsById.get(row.id);
          if (agent) data.push({ type: "agent", value: agent });
          continue;
        }
        const agent = externalAgentsById.get(row.id);
        if (agent) data.push({ type: "external", value: agent });
      }

      return reply.send({
        data,
        pagination: calculatePaginationMeta(candidates.total, {
          limit: query.limit,
          offset: query.offset,
        }),
        totals: {
          agents: candidates.agentTotal,
          externalAgents: candidates.externalAgentTotal,
        },
      });
    },
  );
};

export default agentCatalogRoutes;
