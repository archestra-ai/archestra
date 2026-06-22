import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { EnvironmentDefaultUserLimitModel, EnvironmentModel } from "@/models";
import {
  ApiError,
  CreateEnvironmentDefaultUserLimitSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectEnvironmentDefaultUserLimitSchema,
  UpdateEnvironmentDefaultUserLimitSchema,
  UuidIdSchema,
} from "@/types";

/**
 * Per-environment default user limits. These specialize the org-wide default
 * user limit (managed on the organization via LLM settings): a row here
 * overrides the org-wide default for requests in its environment.
 */
const defaultUserLimitRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/default-user-limits",
    {
      schema: {
        operationId: RouteId.ListDefaultUserLimits,
        description: "List per-environment default user limits for the org.",
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
        description: "Update a per-environment default user limit.",
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
        description: "Delete a per-environment default user limit.",
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
