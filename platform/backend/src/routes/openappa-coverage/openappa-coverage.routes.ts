import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { openappaCoverageService } from "@/openappa/coverage";
import { openappaEnabled } from "@/openappa/service";
import { ApiError, constructResponseSchema } from "@/types";
import {
  CoverageAgentsPageSchema,
  CoverageAgentsQuerySchema,
  CoverageServerParamsSchema,
  CoverageServerSchema,
  CoverageServersPageSchema,
  CoverageServersQuerySchema,
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
    "/api/openappa/coverage/summary",
    {
      schema: {
        operationId: RouteId.GetOpenappaCoverageSummary,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(CoverageSummarySchema),
      },
    },
    async (request) => openappaCoverageService.summary(request.organizationId),
  );
  app.get(
    "/api/openappa/coverage/servers",
    {
      schema: {
        operationId: RouteId.GetOpenappaCoverageServers,
        tags: ["OpenAPPA"],
        querystring: CoverageServersQuerySchema,
        response: constructResponseSchema(CoverageServersPageSchema),
      },
    },
    async (request) =>
      openappaCoverageService.servers({
        organizationId: request.organizationId,
        ...request.query,
      }),
  );
  app.get(
    "/api/openappa/coverage/servers/:catalogId",
    {
      schema: {
        operationId: RouteId.GetOpenappaCoverageServer,
        tags: ["OpenAPPA"],
        params: CoverageServerParamsSchema,
        response: constructResponseSchema(CoverageServerSchema),
      },
    },
    async (request) =>
      openappaCoverageService.server({
        organizationId: request.organizationId,
        catalogId: request.params.catalogId,
      }),
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
        ...request.query,
      }),
  );
  app.get(
    "/api/openappa/coverage/agents",
    {
      schema: {
        operationId: RouteId.GetOpenappaCoverageAgents,
        tags: ["OpenAPPA"],
        querystring: CoverageAgentsQuerySchema,
        response: constructResponseSchema(CoverageAgentsPageSchema),
      },
    },
    async (request) =>
      openappaCoverageService.agents({
        organizationId: request.organizationId,
        ...request.query,
      }),
  );
};
export default routes;
