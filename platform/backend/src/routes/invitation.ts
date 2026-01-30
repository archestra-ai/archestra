import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InvitationModel, UserModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";

const routes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Check if an invitation exists and whether the invited email already has an account
   * This endpoint doesn't require authentication since it's used before sign-up/sign-in
   */
  app.get(
    "/api/invitation/:id/check",
    {
      schema: {
        operationId: RouteId.CheckInvitation,
        description:
          "Check if an invitation is valid and whether the user exists",
        tags: ["Invitation"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(
          z.object({
            invitation: z.object({
              id: z.string(),
              email: z.string().email(),
              organizationId: z.string(),
              status: z.enum(["pending", "accepted", "canceled"]),
              expiresAt: z.string().nullable(),
            }),
            userExists: z.boolean(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      // Get the invitation
      const invitation = await InvitationModel.getById(id);

      if (!invitation) {
        throw new ApiError(404, "Invitation not found");
      }

      // Check if invitation is valid
      if (invitation.status !== "pending") {
        throw new ApiError(
          400,
          `This invitation has already been ${invitation.status}`,
        );
      }

      if (invitation.expiresAt && invitation.expiresAt < new Date()) {
        throw new ApiError(400, "This invitation has expired");
      }

      // Check if a user with this email already exists
      const existingUser = await UserModel.findByEmail(invitation.email);

      return reply.send({
        invitation: {
          id: invitation.id,
          email: invitation.email,
          organizationId: invitation.organizationId,
          status: invitation.status,
          expiresAt: invitation.expiresAt?.toISOString() ?? null,
        },
        userExists: !!existingUser,
      });
    },
  );
};

export default routes;
