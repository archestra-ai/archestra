import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { RetrievalEvaluationComparisonSchema } from "@/knowledge-base/evaluation/schema";
import {
  RetrievalEvaluationAlreadyRunningError,
  RetrievalEvaluationInvalidSettingsError,
  retrievalEvaluationService,
} from "@/services/retrieval-evaluation";
import {
  ApiError,
  constructResponseSchema,
  RetrievalEvaluationCapabilitiesSchema,
  RetrievalEvaluationSettingsOverridesSchema,
  SelectRetrievalEvaluationRunSchema,
  SelectRetrievalEvaluationRunSummarySchema,
  StartRetrievalEvaluationSchema,
} from "@/types";

const BASE_PATH = "/api/organization/knowledge-settings/retrieval-evaluations";
const RunParamsSchema = z.object({ id: z.string().uuid() });

const retrievalEvaluationRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("preHandler", async () => {
    if (!config.kb.evaluationEnabled) {
      throw new ApiError(404, "Not found");
    }
  });

  fastify.get(
    `${BASE_PATH}/capabilities`,
    {
      schema: {
        operationId: RouteId.GetRetrievalEvaluationCapabilities,
        description:
          "Inspect retrieval-evaluation capabilities and fixed golden scenarios",
        tags: ["Organization"],
        response: constructResponseSchema(
          RetrievalEvaluationCapabilitiesSchema,
        ),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(
        await retrievalEvaluationService.getCapabilities({ organizationId }),
      );
    },
  );

  fastify.post(
    `${BASE_PATH}/capabilities/preview`,
    {
      schema: {
        operationId: RouteId.PreviewRetrievalEvaluationCapabilities,
        description:
          "Preview retrieval-evaluation capabilities with run-only Knowledge settings",
        tags: ["Organization"],
        body: RetrievalEvaluationSettingsOverridesSchema,
        response: constructResponseSchema(
          RetrievalEvaluationCapabilitiesSchema,
        ),
      },
    },
    async ({ organizationId, user, body }, reply) => {
      return reply.send(
        await retrievalEvaluationService.getCapabilities({
          organizationId,
          userId: user.id,
          settingsOverrides: body,
          validateOnlineFixtures: true,
        }),
      );
    },
  );

  fastify.get(
    BASE_PATH,
    {
      schema: {
        operationId: RouteId.ListRetrievalEvaluationRuns,
        description: "List recent retrieval-evaluation runs",
        tags: ["Organization"],
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(10),
        }),
        response: constructResponseSchema(
          z.array(SelectRetrievalEvaluationRunSummarySchema),
        ),
      },
    },
    async ({ organizationId, query }, reply) => {
      return reply.send(
        await retrievalEvaluationService.listRuns({
          organizationId,
          limit: query.limit,
        }),
      );
    },
  );

  fastify.post(
    BASE_PATH,
    {
      schema: {
        operationId: RouteId.StartRetrievalEvaluation,
        description:
          "Queue a retrieval evaluation with optional run-only Knowledge settings",
        tags: ["Organization"],
        body: StartRetrievalEvaluationSchema,
        response: constructResponseSchema(SelectRetrievalEvaluationRunSchema),
      },
    },
    async ({ organizationId, user, body }, reply) => {
      try {
        return reply.send(
          await retrievalEvaluationService.startRun({
            organizationId,
            userId: user.id,
            name: body.name,
            queryLimit: body.queryLimit,
            components: body.components,
            settingsOverrides: body.settingsOverrides,
          }),
        );
      } catch (error) {
        if (error instanceof RetrievalEvaluationAlreadyRunningError) {
          throw new ApiError(
            409,
            `Evaluation ${error.run.id} is already ${error.run.status}`,
          );
        }
        if (error instanceof RetrievalEvaluationInvalidSettingsError) {
          throw new ApiError(400, error.message);
        }
        throw error;
      }
    },
  );

  fastify.get(
    `${BASE_PATH}/:id`,
    {
      schema: {
        operationId: RouteId.GetRetrievalEvaluationRun,
        description: "Get one retrieval-evaluation run and its artifact",
        tags: ["Organization"],
        params: RunParamsSchema,
        response: constructResponseSchema(SelectRetrievalEvaluationRunSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      const run = await retrievalEvaluationService.getRun({
        organizationId,
        id: params.id,
      });
      if (!run) throw new ApiError(404, "Retrieval evaluation not found");
      return reply.send(run);
    },
  );

  fastify.post(
    `${BASE_PATH}/:id/cancel`,
    {
      schema: {
        operationId: RouteId.CancelRetrievalEvaluation,
        description: "Request cancellation of a retrieval evaluation",
        tags: ["Organization"],
        params: RunParamsSchema,
        response: constructResponseSchema(SelectRetrievalEvaluationRunSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      const run = await retrievalEvaluationService.cancelRun({
        organizationId,
        id: params.id,
      });
      if (!run) throw new ApiError(404, "Retrieval evaluation not found");
      return reply.send(run);
    },
  );

  fastify.get(
    `${BASE_PATH}/:id/compare/:otherId`,
    {
      schema: {
        operationId: RouteId.CompareRetrievalEvaluations,
        description: "Compare two completed retrieval-evaluation artifacts",
        tags: ["Organization"],
        params: z.object({
          id: z.string().uuid(),
          otherId: z.string().uuid(),
        }),
        response: constructResponseSchema(RetrievalEvaluationComparisonSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      const comparison = await retrievalEvaluationService.compare({
        organizationId,
        beforeId: params.id,
        afterId: params.otherId,
      });
      if (!comparison) {
        throw new ApiError(
          409,
          "Both retrieval evaluations must have completed artifacts",
        );
      }
      return reply.send(comparison);
    },
  );
};

export default retrievalEvaluationRoutes;
