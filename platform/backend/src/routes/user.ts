import { PermissionsSchema, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import RoleCompositionModel from "@/models/role-composition";
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
    "/api/user/permission-sources",
    {
      schema: {
        operationId: RouteId.GetUserPermissionSources,
        description:
          "Get the direct roles and teams granting the current user's permissions",
        tags: ["User"],
        response: constructResponseSchema(
          z.array(
            z.object({
              role: z.string(),
              team: z.object({ id: z.string(), name: z.string() }).nullable(),
              permissions: PermissionsSchema,
            }),
          ),
        ),
      },
    },
    async ({ user, organizationId }) =>
      RoleCompositionModel.getUserSources({ userId: user.id, organizationId }),
  );

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
