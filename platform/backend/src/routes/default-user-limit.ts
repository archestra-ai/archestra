import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { EnvironmentDefaultUserLimitModel, EnvironmentModel } from "@/models";
import {
  listUserLimitUsage,
  resetUserLimitUsage,
} from "@/services/user-limit-usage";
import {
  ApiError,
  CreateEnvironmentDefaultUserLimitSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectEnvironmentDefaultUserLimitSchema,
  UpdateEnvironmentDefaultUserLimitSchema,
  UserLimitUsageQuerySchema,
  UserLimitUsageResponseSchema,
  UuidIdSchema,
} from "@/types";

/**
 * Default user limits: the organization-wide default (no environment) and
 * per-environment overrides, plus each user's usage against the limit that
 * applies to them and a per-user usage reset.
 */
const defaultUserLimitRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/default-user-limits",
    {
      schema: {
        operationId: RouteId.ListDefaultUserLimits,
        description:
          "List the organization's default user limits: the organization-wide default and per-environment overrides.",
        tags: ["Limits"],
        response: constructResponseSchema(
          z.array(SelectEnvironmentDefaultUserLimitSchema),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(
        await EnvironmentDefaultUserLimitModel.findAllForOrganization(
          organizationId,
        ),
      );
    },
  );

  fastify.get(
    "/api/default-user-limits/users",
    {
      schema: {
        operationId: RouteId.ListUserLimitUsage,
        description:
          "List organization members with their spend this window against the limit that applies to them (custom, environment override, or organization default), closest to their limit first.",
        tags: ["Limits"],
        querystring: UserLimitUsageQuerySchema,
        response: constructResponseSchema(UserLimitUsageResponseSchema),
      },
    },
    async ({ query, organizationId }, reply) => {
      return reply.send(await listUserLimitUsage({ organizationId, query }));
    },
  );

  fastify.post(
    "/api/default-user-limits/users/:userId/reset",
    {
      schema: {
        operationId: RouteId.ResetUserLimitUsage,
        description:
          "Start a user's limit usage over from $0 now so their requests are allowed again. The next scheduled reset is unchanged and past usage stays in cost reports.",
        tags: ["Limits"],
        params: z.object({ userId: z.string().min(1) }),
        response: constructResponseSchema(
          z.object({ userId: z.string(), resetAt: z.string() }),
        ),
      },
    },
    async ({ params: { userId }, organizationId, user }, reply) => {
      const result = await resetUserLimitUsage({
        organizationId,
        userId,
        resetByUserId: user.id,
      });
      if (!result) throw new ApiError(404, "User not found");
      return reply.send(result);
    },
  );

  fastify.post(
    "/api/default-user-limits",
    {
      schema: {
        operationId: RouteId.CreateDefaultUserLimit,
        description:
          "Create a default user limit. Omit environmentId for the org-wide default, or set it for a per-environment override.",
        tags: ["Limits"],
        body: CreateEnvironmentDefaultUserLimitSchema,
        response: constructResponseSchema(
          SelectEnvironmentDefaultUserLimitSchema,
        ),
      },
    },
    async ({ body, organizationId }, reply) => {
      if (body.environmentId) {
        const environment = await EnvironmentModel.findByIdForOrganization(
          body.environmentId,
          organizationId,
        );
        if (!environment) {
          throw new ApiError(404, "Environment not found");
        }

        const existing =
          await EnvironmentDefaultUserLimitModel.findByEnvironmentId(
            body.environmentId,
          );
        if (existing) {
          throw new ApiError(
            409,
            "A default user limit already exists for this environment",
          );
        }
      } else {
        // Org-wide default: at most one per organization.
        const existingGlobal =
          await EnvironmentDefaultUserLimitModel.findGlobal(organizationId);
        if (existingGlobal) {
          throw new ApiError(
            409,
            "An organization-wide default user limit already exists",
          );
        }
      }

      return reply.send(
        await EnvironmentDefaultUserLimitModel.create({
          organizationId,
          environmentId: body.environmentId ?? null,
          limitValue: body.limitValue,
          model: body.model ?? null,
          cleanupInterval: body.cleanupInterval,
        }),
      );
    },
  );

  fastify.patch(
    "/api/default-user-limits/:id",
    {
      schema: {
        operationId: RouteId.UpdateDefaultUserLimit,
        description:
          "Update a default user limit (organization-wide or per-environment).",
        tags: ["Limits"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateEnvironmentDefaultUserLimitSchema,
        response: constructResponseSchema(
          SelectEnvironmentDefaultUserLimitSchema,
        ),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const existing =
        await EnvironmentDefaultUserLimitModel.findByIdInOrganization(
          id,
          organizationId,
        );
      if (!existing) {
        throw new ApiError(404, "Default user limit not found");
      }

      const updated = await EnvironmentDefaultUserLimitModel.patch(id, body);
      if (!updated) {
        throw new ApiError(404, "Default user limit not found");
      }

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/default-user-limits/:id",
    {
      schema: {
        operationId: RouteId.DeleteDefaultUserLimit,
        description:
          "Delete a default user limit (organization-wide or per-environment).",
        tags: ["Limits"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const existing =
        await EnvironmentDefaultUserLimitModel.findByIdInOrganization(
          id,
          organizationId,
        );
      if (!existing) {
        throw new ApiError(404, "Default user limit not found");
      }

      await EnvironmentDefaultUserLimitModel.delete(id);
      return reply.send({ success: true });
    },
  );
};

export default defaultUserLimitRoutes;
