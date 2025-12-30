import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { UserTokenModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  UserTokenResponseSchema,
  UserTokenWithValueResponseSchema,
} from "@/types";

const userTokenRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get current user's personal token
   * Creates token if it doesn't exist
   */
  fastify.get(
    "/api/user-tokens/me",
    {
      schema: {
        operationId: RouteId.GetUserToken,
        description: "Get current user's personal token",
        tags: ["UserTokens"],
        response: constructResponseSchema(UserTokenResponseSchema),
      },
    },
    async (request, reply) => {
      const { user, organizationId } = request;

      // Ensure token exists (creates if not)
      const token = await UserTokenModel.ensureUserToken(
        user.id,
        organizationId,
      );

      return reply.send({
        id: token.id,
        name: token.name,
        tokenStart: token.tokenStart,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
      });
    },
  );

  /**
   * Get the full personal token value (for copying to clipboard)
   */
  fastify.get(
    "/api/user-tokens/me/value",
    {
      schema: {
        operationId: RouteId.GetUserTokenValue,
        description: "Get the full personal token value",
        tags: ["UserTokens"],
        response: constructResponseSchema(z.object({ value: z.string() })),
      },
    },
    async (request, reply) => {
      const { user, organizationId } = request;

      const token = await UserTokenModel.findByUserAndOrg(
        user.id,
        organizationId,
      );
      if (!token) {
        throw new ApiError(404, "Personal token not found");
      }

      const tokenValue = await UserTokenModel.getTokenValue(token.id);
      if (!tokenValue) {
        throw new ApiError(500, "Failed to retrieve token value");
      }

      return reply.send({ value: tokenValue });
    },
  );

  /**
   * Rotate personal token (generate new value)
   * Returns the new token value (only shown once)
   */
  fastify.post(
    "/api/user-tokens/me/rotate",
    {
      schema: {
        operationId: RouteId.RotateUserToken,
        description: "Rotate personal token (generate new value)",
        tags: ["UserTokens"],
        response: constructResponseSchema(UserTokenWithValueResponseSchema),
      },
    },
    async (request, reply) => {
      const { user, organizationId } = request;

      const token = await UserTokenModel.findByUserAndOrg(
        user.id,
        organizationId,
      );
      if (!token) {
        throw new ApiError(404, "Personal token not found");
      }

      const result = await UserTokenModel.rotate(token.id);
      if (!result) {
        throw new ApiError(500, "Failed to rotate token");
      }

      // Fetch updated token
      const updatedToken = await UserTokenModel.findById(token.id);
      if (!updatedToken) {
        throw new ApiError(404, "Token not found after rotation");
      }

      return reply.send({
        id: updatedToken.id,
        name: updatedToken.name,
        tokenStart: updatedToken.tokenStart,
        createdAt: updatedToken.createdAt,
        lastUsedAt: updatedToken.lastUsedAt,
        value: result.value,
      });
    },
  );
};

export default userTokenRoutes;
