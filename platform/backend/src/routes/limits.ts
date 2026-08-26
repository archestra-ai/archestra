import { MAX_BULK_IDS, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { LimitModel } from "@/models";
import {
  ApiError,
  CreateLimitSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  LimitEntityTypeSchema,
  LimitTypeSchema,
  LimitWithUsageSchema,
  SelectLimitSchema,
  UpdateLimitSchema,
  UuidIdSchema,
} from "@/types";
import { BulkOutcomeSchema, runBulk } from "./bulk-route";

const BulkDeleteLimitsBodySchema = z.object({
  ids: z
    .array(UuidIdSchema)
    .min(1)
    .max(MAX_BULK_IDS)
    .describe("Limit ids to delete. Duplicates are collapsed."),
});

const limitsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/limits",
    {
      schema: {
        operationId: RouteId.GetLimits,
        description:
          "Get all limits with optional filtering and per-model usage breakdown",
        tags: ["Limits"],
        querystring: z.object({
          entityType: LimitEntityTypeSchema.optional(),
          entityId: z.string().optional(),
          limitType: LimitTypeSchema.optional(),
        }),
        response: constructResponseSchema(z.array(LimitWithUsageSchema)),
      },
    },
    async (
      { query: { entityType, entityId, limitType }, organizationId },
      reply,
    ) => {
      // Cleanup limits if needed before fetching
      await LimitModel.cleanupLimitsIfNeeded({
        allForOrganizationId: organizationId,
        entityType,
        entityId,
        limitType,
      });

      const limits = await LimitModel.findAll(
        entityType,
        entityId,
        limitType,
        organizationId,
      );

      // Add per-model usage breakdown for token_cost limits
      const limitsWithUsage = await Promise.all(
        limits.map(async (limit) => {
          if (limit.limitType === "token_cost") {
            const modelUsage = await LimitModel.getModelUsageBreakdown(
              limit.id,
            );
            return { ...limit, modelUsage };
          }
          return limit;
        }),
      );

      return reply.send(limitsWithUsage);
    },
  );

  fastify.post(
    "/api/limits",
    {
      schema: {
        operationId: RouteId.CreateLimit,
        description: "Create a new limit",
        tags: ["Limits"],
        body: CreateLimitSchema,
        response: constructResponseSchema(SelectLimitSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      // Org-scoping: the limit's target entity must belong to the caller's
      // organization (limitsTable has no org column, so this is the tenancy
      // guard for cross-tenant entity IDs).
      const inOrg = await LimitModel.isEntityInOrganization(
        body.entityType,
        body.entityId,
        organizationId,
      );
      if (!inOrg) {
        throw new ApiError(404, `${body.entityType} not found`);
      }

      return reply.send(await LimitModel.create(body));
    },
  );

  fastify.get(
    "/api/limits/:id",
    {
      schema: {
        operationId: RouteId.GetLimit,
        description: "Get a limit by ID",
        tags: ["Limits"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(LimitWithUsageSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      // Same cleanup the list read performs, so an elapsed reset window is
      // applied before the usage counters are reported either way.
      await LimitModel.cleanupLimitsIfNeeded({
        allForOrganizationId: organizationId,
      });

      const limit = await LimitModel.findByIdInOrganization(id, organizationId);

      if (!limit) {
        throw new ApiError(404, "Limit not found");
      }

      if (limit.limitType !== "token_cost") {
        return reply.send(limit);
      }

      const modelUsage = await LimitModel.getModelUsageBreakdown(limit.id);
      return reply.send({ ...limit, modelUsage });
    },
  );

  fastify.patch(
    "/api/limits/:id",
    {
      schema: {
        operationId: RouteId.UpdateLimit,
        description: "Update a limit",
        tags: ["Limits"],
        params: z.object({
          id: UuidIdSchema,
        }),
        // entityType/entityId are immutable: changing the target entity would
        // bypass the create-time org-scoping guard.
        body: UpdateLimitSchema.omit({
          entityType: true,
          entityId: true,
        }).partial(),
        response: constructResponseSchema(SelectLimitSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const existing = await LimitModel.findByIdInOrganization(
        id,
        organizationId,
      );
      if (!existing) {
        throw new ApiError(404, "Limit not found");
      }

      const limit = await LimitModel.patch(id, body);

      if (!limit) {
        throw new ApiError(404, "Limit not found");
      }

      return reply.send(limit);
    },
  );

  fastify.delete(
    "/api/limits/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteLimits,
        description:
          "Delete several limits in one request. Missing or out-of-organization ids are reported in `failed` while visible limits are deleted.",
        tags: ["Limits"],
        body: BulkDeleteLimitsBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId } = request;
      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "limits bulk delete",
        notFoundMessage: "Limit not found",
        unexpectedMessage: "Could not delete this limit",
        load: async (ids) =>
          new Map(
            (await LimitModel.findByIdsInOrganization(ids, organizationId))
              .filter((limit) => limit.entityType !== "user")
              .map((limit) => [limit.id, limit]),
          ),
        describe: (limit) => `${limit.entityType} limit`,
        applyAll: (entries) =>
          LimitModel.deleteMany(entries.map(({ id }) => id)),
        audit: {
          target: request,
          snapshot: async (ids) => ({
            limits: (
              await LimitModel.findByIdsInOrganization(ids, organizationId)
            )
              .filter((limit) => limit.entityType !== "user")
              .map((limit) => ({
                id: limit.id,
                entityType: limit.entityType,
                entityId: limit.entityId,
                limitType: limit.limitType,
                limitValue: limit.limitValue,
                model: limit.model,
                mcpServerName: limit.mcpServerName,
                toolName: limit.toolName,
                cleanupInterval: limit.cleanupInterval,
              }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          }),
        },
      });
      if (outcome.succeeded.length === 0) request.auditSkip = true;

      return reply.send(outcome);
    },
  );

  fastify.delete(
    "/api/limits/:id",
    {
      schema: {
        operationId: RouteId.DeleteLimit,
        description: "Delete a limit",
        tags: ["Limits"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const existing = await LimitModel.findByIdInOrganization(
        id,
        organizationId,
      );
      if (!existing) {
        throw new ApiError(404, "Limit not found");
      }

      const deleted = await LimitModel.delete(id);

      if (!deleted) {
        throw new ApiError(404, "Limit not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default limitsRoutes;
