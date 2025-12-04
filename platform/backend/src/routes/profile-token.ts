import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { AgentModel, ProfileTokenModel, TeamModel } from "@/models";
import {
  ApiError,
  CreateProfileTokenRequestSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ProfileTokenResponseSchema,
  ProfileTokenWithValueResponseSchema,
  UpdateProfileTokenRequestSchema,
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

      const tokens =
        await ProfileTokenModel.findByProfileIdWithTeams(profileId);

      return reply.send(
        tokens.map((token) => ({
          id: token.id,
          name: token.name,
          tokenStart: token.tokenStart,
          isOrganizationToken: token.isOrganizationToken,
          teams: token.teams,
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt,
        })),
      );
    },
  );

  /**
   * Create a new token for a profile
   * Returns the full token value (only shown once)
   */
  fastify.post(
    "/api/profiles/:profileId/tokens",
    {
      schema: {
        operationId: RouteId.CreateProfileToken,
        description: "Create a new token for a profile",
        tags: ["Profile Tokens"],
        params: z.object({
          profileId: z.string().uuid(),
        }),
        body: CreateProfileTokenRequestSchema,
        response: constructResponseSchema(ProfileTokenWithValueResponseSchema),
      },
    },
    async (request, reply) => {
      const { profileId } = request.params;
      const { name, teamIds, isOrganizationToken } = request.body;
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

      // Validate team IDs if provided
      if (teamIds && teamIds.length > 0) {
        const userTeams = await TeamModel.findByOrganization(
          request.organizationId,
        );
        const validTeamIds = new Set(userTeams.map((t) => t.id));
        for (const teamId of teamIds) {
          if (!validTeamIds.has(teamId)) {
            throw new ApiError(400, `Invalid team ID: ${teamId}`);
          }
        }
      }

      const { token, value } = await ProfileTokenModel.create(
        {
          profileId,
          name,
          isOrganizationToken: isOrganizationToken ?? false,
        },
        isOrganizationToken ? [] : teamIds,
      );

      const teams = await ProfileTokenModel.getTeamsForToken(token.id);

      return reply.send({
        id: token.id,
        name: token.name,
        tokenStart: token.tokenStart,
        isOrganizationToken: token.isOrganizationToken,
        teams,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        value,
      });
    },
  );

  /**
   * Update a token (name, teams, isOrganizationToken)
   */
  fastify.patch(
    "/api/profiles/:profileId/tokens/:tokenId",
    {
      schema: {
        operationId: RouteId.UpdateProfileToken,
        description: "Update a token",
        tags: ["Profile Tokens"],
        params: z.object({
          profileId: z.string().uuid(),
          tokenId: z.string().uuid(),
        }),
        body: UpdateProfileTokenRequestSchema,
        response: constructResponseSchema(ProfileTokenResponseSchema),
      },
    },
    async (request, reply) => {
      const { profileId, tokenId } = request.params;
      const { name, teamIds, isOrganizationToken } = request.body;
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

      // Update token metadata
      const updateData: { name?: string; isOrganizationToken?: boolean } = {};
      if (name !== undefined) updateData.name = name;
      if (isOrganizationToken !== undefined)
        updateData.isOrganizationToken = isOrganizationToken;

      if (Object.keys(updateData).length > 0) {
        await ProfileTokenModel.update(tokenId, updateData);
      }

      // Update teams if provided
      if (teamIds !== undefined) {
        // Validate team IDs
        if (teamIds.length > 0) {
          const userTeams = await TeamModel.findByOrganization(
            request.organizationId,
          );
          const validTeamIds = new Set(userTeams.map((t) => t.id));
          for (const teamId of teamIds) {
            if (!validTeamIds.has(teamId)) {
              throw new ApiError(400, `Invalid team ID: ${teamId}`);
            }
          }
        }
        await ProfileTokenModel.syncTeams(tokenId, teamIds);
      }

      // Fetch updated token with teams
      const token = await ProfileTokenModel.findByIdWithTeams(tokenId);
      if (!token) {
        throw new ApiError(404, "Token not found");
      }

      return reply.send({
        id: token.id,
        name: token.name,
        tokenStart: token.tokenStart,
        isOrganizationToken: token.isOrganizationToken,
        teams: token.teams,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
      });
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

      // Fetch updated token with teams
      const token = await ProfileTokenModel.findByIdWithTeams(tokenId);
      if (!token) {
        throw new ApiError(404, "Token not found");
      }

      return reply.send({
        id: token.id,
        name: token.name,
        tokenStart: token.tokenStart,
        isOrganizationToken: token.isOrganizationToken,
        teams: token.teams,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        value: result.value,
      });
    },
  );

  /**
   * Delete a token
   */
  fastify.delete(
    "/api/profiles/:profileId/tokens/:tokenId",
    {
      schema: {
        operationId: RouteId.DeleteProfileToken,
        description: "Delete a token",
        tags: ["Profile Tokens"],
        params: z.object({
          profileId: z.string().uuid(),
          tokenId: z.string().uuid(),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
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

      const deleted = await ProfileTokenModel.delete(tokenId);
      if (!deleted) {
        throw new ApiError(500, "Failed to delete token");
      }

      return reply.send({ success: true });
    },
  );
};

export default profileTokenRoutes;
