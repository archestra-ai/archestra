import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { UserModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  UserSchema,
} from "@/types";

const userRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * GET /api/users/:userId
   * Get a user by ID
   * Properly exposed RESTful endpoint (not a catch-all auth route)
   */
  fastify.get(
    "/api/users/:userId",
    {
      schema: {
        operationId: "getUser",
        description: "Get a user by ID",
        tags: ["User Management"],
        params: z.object({
          userId: z.string().describe("User ID"),
        }),
        response: constructResponseSchema(UserSchema),
      },
    },
    async (request, reply) => {
      const { userId } = request.params;

      // Users can view their own profile; middleware authz map is currently empty for GetUser
      // If stricter access is needed later, enable a permission check here.

      const user = await UserModel.getById(userId);

      if (!user) {
        throw new ApiError(404, "User not found");
      }

      // Return only the user fields without organization-specific data
      return reply.send({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        role: user.role,
        banned: user.banned,
        banReason: user.banReason,
        banExpires: user.banExpires,
        twoFactorEnabled: user.twoFactorEnabled,
      });
    },
  );
};

export default userRoutes;
