import { MAX_BULK_IDS, parseLabelsParam, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { LimitLabelModel, LimitModel } from "@/models";
import LlmThroughputModel from "@/models/llm-throughput";
import { createLimit, limitReadCleanup } from "@/services/limit";
import {
  assertCanChangeLimit,
  assertLimitTarget,
  getLimitAccess,
} from "@/services/limit-access";
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
  for (const [suffix, operationId] of [
    ["keys", RouteId.GetLimitLabelKeys],
    ["values", RouteId.GetLimitLabelValues],
  ] as const) {
    fastify.get(
      `/api/limits/labels/${suffix}`,
      {
        schema: {
          operationId,
          tags: ["Limits"],
          querystring: z.object({ key: z.string().optional() }),
          response: constructResponseSchema(z.array(z.string())),
        },
      },
      async (request, reply) => {
        const teamIds = await getLimitAccess(request, "read");
        if (!teamIds) {
          return reply.send(
            suffix === "keys"
              ? await LimitLabelModel.getAllKeys(request.organizationId)
              : request.query.key
                ? await LimitLabelModel.getValuesByKey({
                    organizationId: request.organizationId,
                    key: request.query.key,
                  })
                : await LimitLabelModel.getAllValues(request.organizationId),
          );
        }
        const limits = await LimitModel.findAll(
          undefined,
          undefined,
          undefined,
          request.organizationId,
          undefined,
          teamIds,
        );
        const labels = limits.flatMap((limit) => limit.labels);
        return reply.send(
          [
            ...new Set(
              labels
                .filter(
                  (label) =>
                    suffix === "keys" ||
                    !request.query.key ||
                    label.key === request.query.key,
                )
                .map((label) => (suffix === "keys" ? label.key : label.value)),
            ),
          ].sort(),
        );
      },
    );
  }

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
          labels: z
            .string()
            .optional()
            .describe(
              "Filter by labels. Format: key1:val1|val2;key2:val3. AND across keys, OR within values.",
            ),
        }),
        response: constructResponseSchema(z.array(LimitWithUsageSchema)),
      },
    },
    async (request, reply) => {
      const {
        query: { entityType, entityId, limitType, labels },
        organizationId,
      } = request;
      const teamIds = await getLimitAccess(request, "read");
      // Reset elapsed windows before reporting usage.
      await limitReadCleanup.run({
        organizationId,
        entityType,
        entityId,
        limitType,
      });

      const limits = await LimitModel.findAll(
        entityType,
        entityId,
        limitType,
        organizationId,
        parseLabelsParam(labels),
        teamIds,
      );

      // Add per-model usage breakdown for token_cost limits
      const spend = await LimitModel.getSpendUsage(
        limits
          .filter((limit) => limit.limitType === "token_cost")
          .map((limit) => limit.id),
      );

      const throughput = await LlmThroughputModel.usage(limits);
      return reply.send(
        limits.map((limit) => ({
          ...limit,
          ...spend.get(limit.id),
          throughputUsage: throughput.get(limit.id),
        })),
      );
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
    async (request, reply) => {
      const { body, organizationId } = request;
      const teamIds = await getLimitAccess(request, "create");
      assertLimitTarget(teamIds, body);
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

      return reply.send(await createLimit({ ...body, teamManaged: !!teamIds }));
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
    async (request, reply) => {
      const {
        params: { id },
        organizationId,
      } = request;
      const teamIds = await getLimitAccess(request, "read");
      // Same cleanup the list read performs, so an elapsed reset window is
      // applied before the usage counters are reported either way.
      await limitReadCleanup.run({ organizationId });

      const limit = await LimitModel.findByIdInOrganization(id, organizationId);

      if (!limit) {
        throw new ApiError(404, "Limit not found");
      }

      assertLimitTarget(teamIds, limit);
      if (
        limit.limitType !== "token_cost" ||
        limit.cleanupInterval === "minute"
      ) {
        const throughput = await LlmThroughputModel.usage([limit]);
        return reply.send({
          ...limit,
          throughputUsage: throughput.get(limit.id),
        });
      }

      const spend = await LimitModel.getSpendUsage([limit.id]);
      return reply.send({ ...limit, ...spend.get(limit.id) });
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
        // bypass the create-time org-scoping guard. Resets own lastCleanup:
        // setting it here would move the schedule without clearing usage.
        body: UpdateLimitSchema.omit({
          entityType: true,
          entityId: true,
          lastCleanup: true,
        })
          .partial()
          .extend({
            // Null is what older generated clients send for an untouched
            // field; it is accepted and ignored.
            lastCleanup: z
              .null({
                error:
                  "lastCleanup cannot be edited. To reset a spend limit's window, use POST /api/limits/{id}/reset.",
              })
              .optional(),
          }),
        response: constructResponseSchema(SelectLimitSchema),
      },
    },
    async (request, reply) => {
      const {
        params: { id },
        body,
        organizationId,
      } = request;
      const teamIds = await getLimitAccess(request, "update");
      const existing = await LimitModel.findByIdInOrganization(
        id,
        organizationId,
      );
      if (!existing) {
        throw new ApiError(404, "Limit not found");
      }

      assertLimitTarget(teamIds, existing);
      assertCanChangeLimit(teamIds, existing);
      const { lastCleanup: _resetOwned, ...changes } = body;
      const limit = await LimitModel.patch(id, changes);

      if (!limit) {
        throw new ApiError(404, "Limit not found");
      }

      return reply.send(limit);
    },
  );

  fastify.post(
    "/api/limits/:id/reset",
    {
      schema: {
        operationId: RouteId.ResetLimitUsage,
        description:
          "Reset a spend limit's current window to $0, so the requests it blocks run again. Cost reports keep the past spend. A calendar interval keeps its schedule. A rolling interval next resets one interval from now.",
        tags: ["Limits"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectLimitSchema),
      },
    },
    async (request, reply) => {
      const {
        params: { id },
        organizationId,
      } = request;
      // A reset changes the limit, so it takes the same access as an update.
      const teamIds = await getLimitAccess(request, "update");
      const existing = await LimitModel.findByIdInOrganization(
        id,
        organizationId,
      );
      if (!existing) {
        throw new ApiError(404, "Limit not found");
      }
      assertLimitTarget(teamIds, existing);
      assertCanChangeLimit(teamIds, existing);
      if (
        existing.limitType !== "token_cost" ||
        existing.cleanupInterval === "minute"
      ) {
        throw new ApiError(
          400,
          "Only spend limits with an hourly or longer interval can be reset. Other limits recover on their own schedule.",
        );
      }

      await LimitModel.resetLimitsUsage([id]);
      const limit = await LimitModel.findByIdInOrganization(id, organizationId);
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
      const teamIds = await getLimitAccess(request, "delete");
      const visible = (limit: {
        entityType: string;
        entityId: string;
        teamManaged: boolean;
      }) =>
        limit.entityType !== "user" &&
        (!teamIds ||
          (limit.entityType === "team" &&
            teamIds.includes(limit.entityId) &&
            limit.teamManaged));
      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "limits bulk delete",
        notFoundMessage: "Limit not found",
        unexpectedMessage: "Could not delete this limit",
        load: async (ids) =>
          new Map(
            (await LimitModel.findByIdsInOrganization(ids, organizationId))
              .filter(visible)
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
              .filter(visible)
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
    async (request, reply) => {
      const {
        params: { id },
        organizationId,
      } = request;
      const teamIds = await getLimitAccess(request, "delete");
      const existing = await LimitModel.findByIdInOrganization(
        id,
        organizationId,
      );
      if (!existing) {
        throw new ApiError(404, "Limit not found");
      }

      assertLimitTarget(teamIds, existing);
      assertCanChangeLimit(teamIds, existing);
      const deleted = await LimitModel.delete(id);

      if (!deleted) {
        throw new ApiError(404, "Limit not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default limitsRoutes;
