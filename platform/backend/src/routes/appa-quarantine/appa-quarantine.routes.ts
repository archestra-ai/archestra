import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import { AppaQuarantineModel } from "@/models";
import {
  ApiError,
  AppaQuarantineAcknowledgmentResultSchema,
  AppaQuarantineAcknowledgmentSchema,
  AppaQuarantineDetailSchema,
  AppaQuarantineReviewSchema,
  constructResponseSchema,
} from "@/types";

const ListQuarantinesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const appaQuarantineRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/appa-quarantines",
    {
      schema: {
        operationId: RouteId.ListAppaQuarantines,
        tags: ["OpenAPPA"],
        querystring: ListQuarantinesQuerySchema,
        response: constructResponseSchema(z.array(AppaQuarantineReviewSchema)),
      },
    },
    async ({ organizationId, user, query }) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      return AppaQuarantineModel.list({
        organizationId,
        userId: user.id,
        isAgentAdmin,
        limit: query.limit,
      });
    },
  );

  fastify.get(
    "/api/appa-quarantines/:id",
    {
      schema: {
        operationId: RouteId.GetAppaQuarantine,
        tags: ["OpenAPPA"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(AppaQuarantineDetailSchema),
      },
    },
    async ({ organizationId, user, params }) => {
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      const quarantine = await AppaQuarantineModel.get({
        organizationId,
        userId: user.id,
        isAgentAdmin,
        id: params.id,
      });
      if (!quarantine) throw new ApiError(404, "Quarantine not found");
      return quarantine;
    },
  );

  fastify.post(
    "/api/appa-quarantines/:id/acknowledgment",
    {
      schema: {
        operationId: RouteId.AcknowledgeAppaQuarantine,
        tags: ["OpenAPPA"],
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({ acknowledgment: AppaQuarantineAcknowledgmentSchema })
          .strict(),
        response: constructResponseSchema(
          AppaQuarantineAcknowledgmentResultSchema,
        ),
      },
    },
    async (request) => {
      const { organizationId, user, params, body } = request;
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      const result = await AppaQuarantineModel.acknowledge({
        organizationId,
        userId: user.id,
        isAgentAdmin,
        id: params.id,
        acknowledgment: body.acknowledgment,
        audit: {
          actorName: user.name ?? null,
          actorEmail: user.email,
          actorType:
            request.authMethod === "api_key"
              ? "api_key"
              : request.authMethod === "service_account"
                ? "service_account"
                : "user",
          impersonatedBy: request.impersonatedBy ?? null,
          requestId: request.id,
          httpPath: request.url.split("?")[0] ?? request.url,
        },
      });
      if (!result) throw new ApiError(404, "Quarantine not found");
      // The model writes a redacted audit event in its transaction.
      request.auditSkip = true;
      return result;
    },
  );
};

export default appaQuarantineRoutes;
