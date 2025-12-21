import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { TeamModel, TeamTokenModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  TeamTokenResponseSchema,
  TeamTokenWithValueResponseSchema,
} from "@/types";

const tokenRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get all tokens for the organization (org token + all team tokens)
   * Creates org token if it doesn't exist
   */
  fastify.get(
    "/api/tokens",
    {
      schema: {
        operationId: RouteId.GetTokens,
        description:
          "Get all tokens for the organization (org token + team tokens)",
        tags: ["Tokens"],
        response: constructResponseSchema(z.array(TeamTokenResponseSchema)),
      },
    },
    async (_request, reply) => {
      // Ensure org token exists
      await TeamTokenModel.ensureOrganizationToken();

      // Get all tokens with team details
      const tokens = await TeamTokenModel.findAllWithTeam();

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
   * Get the full token value (for copying to clipboard)
   */
  fastify.get(
    "/api/tokens/:tokenId/value",
    {
      schema: {
        operationId: RouteId.GetTokenValue,
        description: "Get the full token value (for copying to clipboard)",
        tags: ["Tokens"],
        params: z.object({
          tokenId: z.string().uuid(),
        }),
        response: constructResponseSchema(z.object({ value: z.string() })),
      },
    },
    async (request, reply) => {
      const { tokenId } = request.params;
      const { organizationId, user, headers } = request;

      // Verify token exists and belongs to this organization
      const token = await TeamTokenModel.findById(tokenId);
      if (!token || token.organizationId !== organizationId) {
        throw new ApiError(404, "Token not found");
      }

      // Check if user is team admin
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );

      // If not team admin, verify user is member of the token's team
      if (!isTeamAdmin && token.teamId) {
        const isMember = await TeamModel.isUserInTeam(token.teamId, user.id);
        if (!isMember) {
          throw new ApiError(403, "Not authorized to access this token");
        }
      }

      // Get the decrypted token value
      const tokenValue = await TeamTokenModel.getTokenValue(tokenId);
      if (!tokenValue) {
        throw new ApiError(500, "Failed to retrieve token value");
      }

      return reply.send({ value: tokenValue });
    },
  );

  /**
   * Rotate a token (generate new value)
   * Returns the new token value (only shown once)
   */
  fastify.post(
    "/api/tokens/:tokenId/rotate",
    {
      schema: {
        operationId: RouteId.RotateToken,
        description: "Rotate a token (generate new value)",
        tags: ["Tokens"],
        params: z.object({
          tokenId: z.string().uuid(),
        }),
        response: constructResponseSchema(TeamTokenWithValueResponseSchema),
      },
    },
    async (request, reply) => {
      const { tokenId } = request.params;
      const { organizationId, user, headers } = request;

      // Verify token exists and belongs to this organization
      const existingToken = await TeamTokenModel.findById(tokenId);
      if (!existingToken || existingToken.organizationId !== organizationId) {
        throw new ApiError(404, "Token not found");
      }

      // Check if user is team admin
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );

      // If not team admin, verify user is member of the token's team
      if (!isTeamAdmin && existingToken.teamId) {
        const isMember = await TeamModel.isUserInTeam(
          existingToken.teamId,
          user.id,
        );
        if (!isMember) {
          throw new ApiError(403, "Not authorized to rotate this token");
        }
      }

      // Rotate the token
      const result = await TeamTokenModel.rotate(tokenId);
      if (!result) {
        throw new ApiError(500, "Failed to rotate token");
      }

      // Fetch updated token with team
      const token = await TeamTokenModel.findByIdWithTeam(tokenId);
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

export default tokenRoutes;
