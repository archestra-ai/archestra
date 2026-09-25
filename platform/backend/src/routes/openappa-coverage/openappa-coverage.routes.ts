import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getAgentTypePermissionChecker } from "@/auth";
import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
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
      const visibility = await coverageVisibility(
        request.user.id,
        request.organizationId,
      );
      return openappaCoverageService.entities({
        organizationId: request.organizationId,
        ...visibility,
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
  // Registry administration is `update` on every entry, the grant the
  // retired `mcpServerInstallation:admin` role action converted into.
  const [checker, isCatalogAdmin] = await Promise.all([
    getAgentTypePermissionChecker({ userId, organizationId }),
    isMcpInstallationAdmin({ userId, organizationId }),
  ]);
  const visibleCatalogIds = await InternalMcpCatalogModel.findAccessibleIds({
    userId,
    isAdmin: isCatalogAdmin,
    organizationId,
  });
  return {
    userId,
    visibleCatalogIds,
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
