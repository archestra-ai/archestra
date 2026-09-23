import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getAgentTypePermissionChecker, hasPermission } from "@/auth";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import { openappaCoverageService } from "@/openappa/coverage";
import { openappaEnabled } from "@/openappa/service";
import { ApiError, constructResponseSchema } from "@/types";
import {
  CoverageEntitiesPageSchema,
  CoverageEntitiesQuerySchema,
  CoverageToolsPageSchema,
  CoverageToolsQuerySchema,
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
        querystring: CoverageEntitiesQuerySchema,
        response: constructResponseSchema(CoverageEntitiesPageSchema),
      },
    },
    async (request) => {
      const [{ success: isCatalogAdmin }, visibility] = await Promise.all([
        hasPermission({ mcpServerInstallation: ["admin"] }, request.headers),
        coverageVisibility(request.user.id, request.organizationId),
      ]);
      const visibleCatalogIds = await InternalMcpCatalogModel.findAccessibleIds(
        {
          userId: request.user.id,
          isAdmin: isCatalogAdmin,
          organizationId: request.organizationId,
        },
      );
      return openappaCoverageService.entities({
        organizationId: request.organizationId,
        ...visibility,
        visibleCatalogIds,
        ...request.query,
      });
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
};

async function coverageVisibility(userId: string, organizationId: string) {
  const checker = await getAgentTypePermissionChecker({
    userId,
    organizationId,
  });
  return {
    userId,
    agentTypes: checker
      .getAgentTypesWithPermission("read")
      .filter(
        (type): type is "agent" | "mcp_gateway" =>
          type === "agent" || type === "mcp_gateway",
      ),
    excludeOtherPersonalTypes: (["agent", "mcp_gateway"] as const).filter(
      (type) => checker.isAdmin(type),
    ),
  };
}
export default routes;
