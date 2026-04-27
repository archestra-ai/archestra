import { PermissionsSchema, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import MemberModel from "@/models/member";
import OrganizationRoleModel from "@/models/organization-role";
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
      // Get user's member record to find their role
      const member = await MemberModel.getByUserId(user.id, organizationId);

      if (!member || !member.role) {
        throw new ApiError(404, "User is not a member of any organization");
      }

      // Get permissions for the user's role
      const permissions = await OrganizationRoleModel.getPermissions(
        member.role,
        organizationId,
      );

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
      const candidates = await MemberModel.findImpersonationCandidates({
        organizationId,
        excludeUserId: user.id,
      });
      return reply.send(candidates);
    },
  );
};

export default userRoutes;
