// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  ResourcePermissionActionSchema,
  ResourcePermissionScopeSchema,
  RouteId,
  ScopedResourceSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ResourcePermissions } from "@/services/resource-permissions";
import { constructResponseSchema } from "@/types";
import {
  PermissionSubjectOptionSchema,
  ResourcePermissionsResponseSchema,
  UpdateResourcePermissionPolicySchema,
} from "@/types/resource-permission";

const resourcePermissionRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/resource-permissions/:resource/creation-subjects",
    {
      schema: {
        operationId: RouteId.SearchInitialPermissionSubjects,
        tags: ["Permissions"],
        params: z.object({ resource: ScopedResourceSchema }),
        querystring: z.object({ query: z.string().max(200).default("") }),
        response: constructResponseSchema(
          z.array(PermissionSubjectOptionSchema),
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await ResourcePermissions.searchInitialSubjects({
          ...request.params,
          query: request.query.query,
          organizationId: request.organizationId,
          userId: request.user.id,
        }),
      ),
  );
  fastify.get(
    "/api/resource-permissions",
    {
      schema: {
        operationId: RouteId.GetScopedCapabilities,
        tags: ["Permissions"],
        description:
          "The signed-in actor's explicit scoped capabilities. Used for discovery; each operation still authorizes its target.",
        response: constructResponseSchema(
          z.array(
            z.object({
              organizationId: z.string(),
              resource: ScopedResourceSchema,
              scope: ResourcePermissionScopeSchema,
              action: ResourcePermissionActionSchema,
            }),
          ),
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await ResourcePermissions.resolveAll({
          userId: request.user.id,
          organizationId: request.organizationId,
        }),
      ),
  );
  fastify.get(
    "/api/resource-permissions/:resource/:scope/subjects",
    {
      schema: {
        operationId: RouteId.SearchResourcePermissionSubjects,
        tags: ["Permissions"],
        params: ParamsSchema,
        querystring: z.object({ query: z.string().max(200).default("") }),
        response: constructResponseSchema(
          z.array(PermissionSubjectOptionSchema),
        ),
      },
    },
    async (request, reply) =>
      reply.send(
        await ResourcePermissions.searchSubjects({
          ...request.params,
          query: request.query.query,
          userId: request.user.id,
          organizationId: request.organizationId,
        }),
      ),
  );
  fastify.get(
    "/api/resource-permissions/:resource/:scope",
    {
      schema: {
        operationId: RouteId.GetResourcePermissions,
        tags: ["Permissions"],
        description:
          "Read direct grants and effective actions for an object or all objects of one resource type",
        params: ParamsSchema,
        response: constructResponseSchema(ResourcePermissionsResponseSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await ResourcePermissions.getPolicy({
          ...request.params,
          organizationId: request.organizationId,
          userId: request.user.id,
        }),
      ),
  );

  fastify.put(
    "/api/resource-permissions/:resource/:scope",
    {
      schema: {
        operationId: RouteId.UpdateResourcePermissions,
        tags: ["Permissions"],
        description:
          "Replace direct resource grants with optimistic concurrency and delegation checks",
        params: ParamsSchema,
        body: UpdateResourcePermissionPolicySchema,
        response: constructResponseSchema(ResourcePermissionsResponseSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await ResourcePermissions.updatePolicy({
          ...request.params,
          ...request.body,
          organizationId: request.organizationId,
          userId: request.user.id,
        }),
      ),
  );
};

export default resourcePermissionRoutes;

const ParamsSchema = z.object({
  resource: ScopedResourceSchema,
  scope: ResourcePermissionScopeSchema,
});
