import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { AgentModel, ProfileTokenModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  ProfileTokenResponseSchema,
  ProfileTokenWithValueResponseSchema,
} from "@/types";

const profileTokenRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get all tokens for a profile
   */
  fastify.get(
    "/api/profiles/:profileId/tokens",
    {
      schema: {
        operationId: RouteId.GetProfileTokens,
        description: "Get all tokens for a profile",
        tags: ["Profile Tokens"],
        params: z.object({
          profileId: z.string().uuid(),
        }),
        response: constructResponseSchema(z.array(ProfileTokenResponseSchema)),
      },
    },
    async (request, reply) => {
      const { profileId } = request.params;
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        request.headers,
      );

      // Verify profile exists and user has access
      const profile = await AgentModel.findById(
        profileId,
        request.user.id,
        isAgentAdmin,
      );
      if (!profile) {
        throw new ApiError(404, "Profile not found");
      }

      const tokens = await ProfileTokenModel.findByProfileIdWithTeam(profileId);

      return reply.send(
        tokens.map((token) => ({
          id: token.id,
          name: token.name,
          tokenStart: token.tokenStart,
          isOrganizationToken: token.isOrganizationToken,
          team: token.team,
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt,
        })),
      );
    },
  );

  /**
   * Rotate a token (generate new value)
   * Returns the new token value (only shown once)
   */
  fastify.post(
    "/api/profiles/:profileId/tokens/:tokenId/rotate",
    {
      schema: {
        operationId: RouteId.RotateProfileToken,
        description: "Rotate a token (generate new value)",
        tags: ["Profile Tokens"],
        params: z.object({
          profileId: z.string().uuid(),
          tokenId: z.string().uuid(),
        }),
        response: constructResponseSchema(ProfileTokenWithValueResponseSchema),
      },
    },
    async (request, reply) => {
      const { profileId, tokenId } = request.params;
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        request.headers,
      );

      // Verify profile exists and user has access
      const profile = await AgentModel.findById(
        profileId,
        request.user.id,
        isAgentAdmin,
      );
      if (!profile) {
        throw new ApiError(404, "Profile not found");
      }

      // Verify token exists and belongs to this profile
      const existingToken = await ProfileTokenModel.findById(tokenId);
      if (!existingToken || existingToken.profileId !== profileId) {
        throw new ApiError(404, "Token not found");
      }

      // Rotate the token
      const result = await ProfileTokenModel.rotate(tokenId);
      if (!result) {
        throw new ApiError(500, "Failed to rotate token");
      }

      // Fetch updated token with team
      const token = await ProfileTokenModel.findByIdWithTeam(tokenId);
      if (!token) {
        throw new ApiError(404, "Token not found");
      }

      return reply.send({
        id: token.id,
        name: token.name,
        tokenStart: token.tokenStart,
        isOrganizationToken: token.isOrganizationToken,
        team: token.team,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        value: result.value,
      });
    },
  );
};

export default profileTokenRoutes;
