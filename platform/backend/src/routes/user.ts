import {
  CursorQuerySchema,
  createCursorPaginatedResponseSchema,
  PermissionsSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import MemberModel from "@/models/member";
import RoleCompositionModel from "@/models/role-composition";
import { getUserPermissions } from "@/services/user";
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
          "Search users in the caller's organization that admins can impersonate (role debugger) in bounded pages. The caller is excluded.",
        tags: ["User"],
        querystring: CursorQuerySchema.extend({
          search: z.string().optional().describe("Matches name or email"),
        }),
        response: constructResponseSchema(
          createCursorPaginatedResponseSchema(ImpersonableUserSchema),
        ),
      },
    },
    async ({ user, organizationId, query }, reply) => {
      if (config.auth.disableImpersonation) {
        throw new ApiError(
          403,
          "User impersonation is disabled on this deployment",
        );
      }
      // Exclude the caller only. System-level `user.role = "admin"` is synced
      // onto anyone whose org role grants `member:impersonate`, so filtering
      // those out would make it impossible to view-as another admin — the
      // role debugger's actual job. better-auth is configured to allow it.
      return reply.send(
        await MemberModel.findImpersonationCandidates({
          organizationId,
          excludeUserId: user.id,
          pagination: { limit: query.limit, cursor: query.cursor },
          search: query.search,
        }),
      );
    },
  );
};

export default userRoutes;
