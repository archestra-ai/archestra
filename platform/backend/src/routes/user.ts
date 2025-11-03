import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { UserModel } from "@/models";
import { ErrorResponseSchema, RouteId } from "@/types";
import { SelectUserSchema, UpdateUserOnboardingBodySchema } from "@/types/user";
import { getUserFromRequest } from "@/utils";

const userRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Update a user onboarding
   */
  fastify.put(
    "/api/users/:id/onboarding",
    {
      schema: {
        operationId: RouteId.UpdateUserOnboarding,
        description: "Update a user's onboarding status",
        tags: ["Users"],
        params: z.object({
          id: z.string(),
        }),
        body: UpdateUserOnboardingBodySchema,
        response: {
          200: SelectUserSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);
        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }
        fastify.log.info(
          `user updating onboarding: ${request.params.id} by ${user.id}`,
        );
        if (user.id !== request.params.id && !user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Update onboarding status
        const userResult = await UserModel.setOnboardingCompleted(
          request.params.id,
          request.body.onboardingCompleted,
        );

        if (!userResult) {
          return reply.status(404).send({
            error: {
              message: "User not found",
              type: "not_found",
            },
          });
        }

        return reply.send(userResult);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );
};

export default userRoutes;
