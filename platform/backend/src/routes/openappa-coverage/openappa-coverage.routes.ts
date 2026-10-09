import { calculatePaginationMeta, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  coverageVisibility,
  openappaCoverageService,
} from "@/openappa/coverage";
import { openappaEnabled } from "@/openappa/service";
import { listObservedMcpServers } from "@/services/observed-mcp-servers";
import { ApiError, constructResponseSchema } from "@/types";
import type { ObservedMcpServer } from "@/types/observed-mcp-server";
import {
  type CoverageEntitiesPage,
  CoverageEntitiesRoutePageSchema,
  type CoverageEntitiesRouteQuery,
  CoverageEntitiesRouteQuerySchema,
  CoverageSummarySchema,
  CoverageToolsPageSchema,
  CoverageToolsQuerySchema,
  type ObservedCoverageEntity,
} from "@/types/openappa-coverage";

/**
 * Read-only views of what the policy covers: nothing here changes state, so
 * no route produces an audit record.
 */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", async () => {
    if (!openappaEnabled())
      throw new ApiError(404, "Guardrails v2 is disabled");
  });
  app.get(
    "/api/openappa/coverage/entities",
    {
      schema: {
        operationId: RouteId.GetOpenappaCoverageEntities,
        tags: ["OpenAPPA"],
        querystring: CoverageEntitiesRouteQuerySchema,
        response: constructResponseSchema(CoverageEntitiesRoutePageSchema),
      },
    },
    async (request) => {
      const { type, includeObserved, ...query } = request.query;
      // `entityId` and `toolId` name registry targets; no observed server is one.
      const observedWanted =
        (type === "observed_mcp_server" ||
          (type === "mcp_server" && includeObserved === true)) &&
        !query.entityId &&
        !query.toolId;
      const observedRows = observedWanted
        ? listObservedMcpServers(request.organizationId).then((servers) =>
            observedEntities(servers, query),
          )
        : Promise.resolve([]);
      if (type === "observed_mcp_server") {
        return pageOf(await observedRows, query);
      }
      const registryRows = coverageVisibility(
        request.user.id,
        request.organizationId,
      ).then((visibility) =>
        openappaCoverageService.entities({
          organizationId: request.organizationId,
          ...visibility,
          ...query,
          type,
        }),
      );
      const [registry, observed] = await Promise.all([
        registryRows,
        observedRows,
      ]);
      return appendObserved(registry, observed, query);
    },
  );
  app.get(
    "/api/openappa/coverage/tools",
    {
      schema: {
        operationId: RouteId.GetOpenappaCoverageTools,
        tags: ["OpenAPPA"],
        querystring: CoverageToolsQuerySchema,
        response: constructResponseSchema(CoverageToolsPageSchema),
      },
    },
    async (request) =>
      openappaCoverageService.tools({
        organizationId: request.organizationId,
        ...(await coverageVisibility(request.user.id, request.organizationId)),
        ...request.query,
      }),
  );
  app.get(
    "/api/openappa/coverage/summary",
    {
      schema: {
        operationId: RouteId.GetOpenappaCoverageSummary,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(CoverageSummarySchema),
      },
    },
    async (request) =>
      openappaCoverageService.summary({
        organizationId: request.organizationId,
        ...(await coverageVisibility(request.user.id, request.organizationId)),
      }),
  );
};

export default routes;

// === Internal helpers ===

type EntitiesPaging = Pick<
  CoverageEntitiesRouteQuery,
  "search" | "sortBy" | "sortDirection" | "limit" | "offset"
>;

/** Observed servers as list rows: the search and sort the registry rows get. */
function observedEntities(
  servers: ObservedMcpServer[],
  query: EntitiesPaging,
): ObservedCoverageEntity[] {
  const search = query.search?.toLowerCase();
  const direction = query.sortDirection === "desc" ? -1 : 1;
  const key = (entity: ObservedCoverageEntity) =>
    query.sortBy === "tools" ? entity.toolCount : entity.name;
  return servers
    .filter((server) => !search || server.label.toLowerCase().includes(search))
    .map((server) => ({
      type: "observed_mcp_server" as const,
      id: server.id,
      name: server.label,
      label: server.label,
      toolCount: server.tools.length,
      firstObservedAt: server.firstObservedAt,
    }))
    .sort((a, b) => {
      const left = key(a);
      const right = key(b);
      const order =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right));
      // Ties by name, as coverage sorts, then by id so equal labels on two
      // clients keep one order.
      return (
        direction * order ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
      );
    });
}

function pageOf(
  rows: ObservedCoverageEntity[],
  paging: Pick<EntitiesPaging, "limit" | "offset">,
) {
  return {
    data: rows.slice(paging.offset, paging.offset + paging.limit),
    pagination: calculatePaginationMeta(rows.length, paging),
  };
}

/**
 * One paged list over registry rows then observed rows: the registry page is
 * what coverage returned for this offset, and observed rows fill the rest of
 * the page from where the registry's total left off.
 */
function appendObserved(
  registry: CoverageEntitiesPage,
  observed: ObservedCoverageEntity[],
  paging: Pick<EntitiesPaging, "limit" | "offset">,
) {
  if (observed.length === 0) return registry;
  const room = paging.limit - registry.data.length;
  const start = Math.max(0, paging.offset - registry.pagination.total);
  return {
    data: [
      ...registry.data,
      ...(room > 0 ? observed.slice(start, start + room) : []),
    ],
    pagination: calculatePaginationMeta(
      registry.pagination.total + observed.length,
      paging,
    ),
  };
}
