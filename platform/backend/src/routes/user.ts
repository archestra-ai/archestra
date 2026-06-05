import { PermissionsSchema, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getUserPermissions, listImpersonableUsers } from "@/services/user";
import { constructResponseSchema } from "@/types";

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
      const candidates = await listImpersonableUsers({
        organizationId,
        currentUserId: user.id,
      });
      return reply.send(candidates);
    },
  );
};

export default userRoutes;
