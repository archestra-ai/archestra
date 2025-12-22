import type { IncomingHttpHeaders } from "node:http";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { TeamModel, TeamTokenModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  type SelectTeamToken,
  TeamTokenWithValueResponseSchema,
  TokensListResponseSchema,
} from "@/types";

/**
 * Check if user has access to a specific token based on permissions.
 * - Org tokens: require ac:update permission
 * - Team tokens: require team:admin OR (team:update AND team membership)
 */
async function checkTokenAccess(
  token: SelectTeamToken,
  userId: string,
  headers: IncomingHttpHeaders,
): Promise<void> {
  if (token.isOrganizationToken) {
    // Org tokens require ac:update permission
    const { success: hasAcUpdate } = await hasPermission(
      { ac: ["update"] },
      headers,
    );
    if (!hasAcUpdate) {
      throw new ApiError(403, "Not authorized to access organization token");
    }
  } else if (token.teamId) {
    // Team tokens require team:admin OR (team:update AND team membership)
    const { success: isTeamAdmin } = await hasPermission(
      { team: ["admin"] },
      headers,
    );

    if (!isTeamAdmin) {
      const { success: hasTeamUpdate } = await hasPermission(
        { team: ["update"] },
        headers,
      );
      if (!hasTeamUpdate) {
        throw new ApiError(403, "Not authorized to access this token");
      }

      const isMember = await TeamModel.isUserInTeam(token.teamId, userId);
      if (!isMember) {
        throw new ApiError(403, "Not authorized to access this token");
      }
    }
  }
}

const tokenRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get tokens visible to the user based on their permissions:
   * - ac:update: can see org-wide token
   * - team:admin: can see all team tokens
   * - team:update + team membership: can see own team tokens only
   *
   * Also returns permission flags so the UI can show disabled options
   * for tokens the user doesn't have access to.
   */
  fastify.get(
    "/api/tokens",
    {
      schema: {
        operationId: RouteId.GetTokens,
        description:
          "Get tokens visible to the user based on their permissions",
        tags: ["Tokens"],
        response: constructResponseSchema(TokensListResponseSchema),
      },
    },
    async (request, reply) => {
      const { user, headers } = request;

      // Check permissions
      const { success: canAccessOrgToken } = await hasPermission(
        { ac: ["update"] },
        headers,
      );
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );
      const { success: hasTeamUpdate } = await hasPermission(
        { team: ["update"] },
        headers,
      );

      // User can access team tokens if they have team:admin OR team:update
      const canAccessTeamTokens = isTeamAdmin || hasTeamUpdate;

      // Ensure org token exists
      await TeamTokenModel.ensureOrganizationToken();

      // Get all tokens with team details
      const allTokens = await TeamTokenModel.findAllWithTeam();

      // Filter tokens based on permissions
      let visibleTokens = allTokens;

      // Filter org tokens (only ac:update can see)
      if (!canAccessOrgToken) {
        visibleTokens = visibleTokens.filter(
          (token) => !token.isOrganizationToken,
        );
      }

      // Filter team tokens
      if (!isTeamAdmin) {
        if (!hasTeamUpdate) {
          // No team:update permission = no team tokens visible
          visibleTokens = visibleTokens.filter(
            (token) => token.isOrganizationToken,
          );
        } else {
          // Only own team tokens visible
          const userTeamIds = await TeamModel.getUserTeamIds(user.id);
          visibleTokens = visibleTokens.filter(
            (token) =>
              token.isOrganizationToken ||
              (token.teamId && userTeamIds.includes(token.teamId)),
          );
        }
      }

      return reply.send({
        tokens: visibleTokens.map((token) => ({
          id: token.id,
          name: token.name,
          tokenStart: token.tokenStart,
          isOrganizationToken: token.isOrganizationToken,
          team: token.team,
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt,
        })),
        permissions: {
          canAccessOrgToken,
          canAccessTeamTokens,
        },
      });
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

      // Check user has access to this token
      await checkTokenAccess(token, user.id, headers);

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

      // Check user has access to this token
      await checkTokenAccess(existingToken, user.id, headers);

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
