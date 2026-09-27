import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  coverageVisibility,
  openappaCoverageService,
} from "@/openappa/coverage";
import { openappaEnabled } from "@/openappa/service";
import { ApiError, constructResponseSchema } from "@/types";
import {
  CoverageEntitiesPageSchema,
  CoverageEntitiesQuerySchema,
  CoverageSummarySchema,
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
