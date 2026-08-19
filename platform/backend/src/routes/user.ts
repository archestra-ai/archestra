import {
  PermissionsSchema,
  RoleResourceAccessSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { getUserResourceAccess } from "@/services/role-resource-access";
import { getUserPermissions, listImpersonableUsers } from "@/services/user";
import { ApiError, constructResponseSchema } from "@/types";

const ImpersonableUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string().nullable(),
});

const userRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/user/permissions",
    {
      schema: {
        operationId: RouteId.GetUserPermissions,
        description: "Get current user's permissions",
        tags: ["User"],
        response: constructResponseSchema(PermissionsSchema),
      },
    },
    async ({ user, organizationId }, reply) => {
      const permissions = await getUserPermissions({
        userId: user.id,
        organizationId,
      });
      return reply.send(permissions);
    },
  );

  fastify.get(
    "/api/user/resource-access",
    {
      schema: {
        operationId: RouteId.GetUserResourceAccess,
        description:
          "Which entries of the built-in catalogs (model providers, knowledge connectors, messaging channels, connection-page clients) the caller's role allows. A null list means unrestricted; an empty list means none.",
        tags: ["User"],
        response: constructResponseSchema(RoleResourceAccessSchema),
      },
    },
    async ({ user, organizationId }, reply) => {
      const access = await getUserResourceAccess({
        userId: user.id,
        organizationId,
      });
      return reply.send(access);
    },
  );

  fastify.get(
    "/api/user/impersonable",
    {
      schema: {
        operationId: RouteId.GetImpersonableUsers,
        description:
          "List users in the caller's organization that admins can impersonate (role debugger)",
        tags: ["User"],
        response: constructResponseSchema(z.array(ImpersonableUserSchema)),
      },
    },
    async ({ user, organizationId }, reply) => {
      if (config.auth.disableImpersonation) {
        throw new ApiError(
          403,
          "User impersonation is disabled on this deployment",
        );
      }
      const candidates = await listImpersonableUsers({
        organizationId,
        currentUserId: user.id,
      });
      return reply.send(candidates);
    },
  );
};

export default userRoutes;
