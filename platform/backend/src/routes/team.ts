import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission, hasPermission } from "@/auth";
import config from "@/config";
import { AgentToolModel, OrganizationModel, TeamModel } from "@/models";
import {
  AddTeamExternalGroupBodySchema,
  AddTeamMemberBodySchema,
  ApiError,
  CreateTeamBodySchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectTeamExternalGroupSchema,
  SelectTeamMemberListItemSchema,
  SelectTeamMemberSchema,
  SelectTeamSchema,
  UpdateTeamBodySchema,
} from "@/types";

// requireTeamCompressionScope rejects team-level convertToolResultsToToon=true
// writes when the organization's compressionScope is not "team" — the runtime
// TOON cascade (routes/proxy/utils/toon-conversion.ts) only consults team
// flags under team scope, so setting it under "organization" scope would be
// silently inert. Returning 400 here surfaces the misconfiguration at
// write-time instead of at first-request time.
async function requireTeamCompressionScope(
  organizationId: string,
  convertToolResultsToToon: boolean | undefined,
): Promise<void> {
  if (convertToolResultsToToon !== true) {
    return;
  }
  const org = await OrganizationModel.getById(organizationId);
  if (org && org.compressionScope !== "team") {
    throw new ApiError(
      400,
      `convertToolResultsToToon=true requires organization.compressionScope to be "team" (currently "${org.compressionScope}"). Update the organization first, or omit the field.`,
    );
  }
}

const teamRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/teams",
    {
      schema: {
        operationId: RouteId.GetTeams,
        description: "Get all teams in the organization",
        tags: ["Teams"],
        querystring: PaginationQuerySchema.extend({
          name: z.string().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectTeamSchema),
        ),
      },
    },
    async (request, reply) => {
      const { limit, offset, name } = request.query;
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        request.headers,
      );

      // Non-team admins only see teams they're members of
      if (!isTeamAdmin) {
        const result = await TeamModel.getUserTeamsPaginated({
          userId: request.user.id,
          limit,
          offset,
          name,
        });
        return reply.send({
          data: result.data,
          pagination: calculatePaginationMeta(result.total, { limit, offset }),
        });
      }
      // Team admins see all teams in the organization
      const result = await TeamModel.findByOrganizationPaginated({
        organizationId: request.organizationId,
        limit,
        offset,
        name,
      });
      return reply.send({
        data: result.data,
        pagination: calculatePaginationMeta(result.total, { limit, offset }),
      });
    },
  );

  fastify.post(
    "/api/teams",
    {
      schema: {
        operationId: RouteId.CreateTeam,
        description: "Create a new team",
        tags: ["Teams"],
        body: CreateTeamBodySchema,
        response: constructResponseSchema(SelectTeamSchema),
      },
    },
    async (
      {
        body: { name, description, convertToolResultsToToon },
        user,
        organizationId,
      },
      reply,
    ) => {
      await requireTeamCompressionScope(
        organizationId,
        convertToolResultsToToon,
      );
      return reply.send(
        await TeamModel.create({
          name,
          description,
          organizationId,
          createdBy: user.id,
          convertToolResultsToToon,
        }),
      );
    },
  );

  fastify.get(
    "/api/teams/:id",
    {
      schema: {
        operationId: RouteId.GetTeam,
        description: "Get a team by ID",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(SelectTeamSchema),
      },
    },
    async ({ params: { id }, organizationId, user, headers }, reply) => {
      const team = await TeamModel.findById(id);

      if (!team) {
        throw new ApiError(404, "Team not found");
      }

      // Verify the team belongs to the user's organization
      if (team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user is team:admin or member of the team
      // Non team:admins can only see their own teams
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );
      if (!isTeamAdmin) {
        const isMember = await TeamModel.isUserInTeam(id, user.id);
        if (!isMember) {
          throw new ApiError(404, "Team not found");
        }
      }

      return reply.send(team);
    },
  );

  fastify.put(
    "/api/teams/:id",
    {
      schema: {
        operationId: RouteId.UpdateTeam,
        description: "Update a team",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
        }),
        body: UpdateTeamBodySchema,
        response: constructResponseSchema(SelectTeamSchema),
      },
    },
    async ({ params: { id }, body, organizationId, user, headers }, reply) => {
      // Verify the team exists and belongs to the user's organization
      const existingTeam = await TeamModel.findById(id);
      if (!existingTeam || existingTeam.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user has team:admin permission or is a member of the team
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );

      if (!isTeamAdmin) {
        const isMember = await TeamModel.isUserInTeam(id, user.id);
        if (!isMember) {
          throw new ApiError(
            403,
            "You must be a member of this team to update it",
          );
        }
      }

      await requireTeamCompressionScope(
        organizationId,
        body.convertToolResultsToToon,
      );

      const team = await TeamModel.update(id, body);

      if (!team) {
        throw new ApiError(404, "Team not found");
      }

      return reply.send(team);
    },
  );

  fastify.delete(
    "/api/teams/:id",
    {
      schema: {
        operationId: RouteId.DeleteTeam,
        description: "Delete a team",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user, headers }, reply) => {
      // Verify the team exists and belongs to the user's organization
      const existingTeam = await TeamModel.findById(id);
      if (!existingTeam || existingTeam.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user has team:admin permission or is a member of the team
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );

      if (!isTeamAdmin) {
        const isMember = await TeamModel.isUserInTeam(id, user.id);
        if (!isMember) {
          throw new ApiError(
            403,
            "You must be a member of this team to delete it",
          );
        }
      }

      const success = await TeamModel.delete(id);

      if (!success) {
        throw new ApiError(404, "Team not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/teams/:id/members",
    {
      schema: {
        operationId: RouteId.GetTeamMembers,
        description: "Get all members of a team",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(
          z.array(SelectTeamMemberListItemSchema),
        ),
      },
    },
    async ({ params: { id }, organizationId, user, headers }, reply) => {
      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user is team:admin or member of the team
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );
      if (!isTeamAdmin) {
        const isMember = await TeamModel.isUserInTeam(id, user.id);
        if (!isMember) {
          throw new ApiError(404, "Team not found");
        }
      }

      return reply.send(await TeamModel.getTeamMembersWithUsers(id));
    },
  );

  fastify.post(
    "/api/teams/:id/members",
    {
      schema: {
        operationId: RouteId.AddTeamMember,
        description: "Add a member to a team",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
        }),
        body: AddTeamMemberBodySchema,
        response: constructResponseSchema(SelectTeamMemberSchema),
      },
    },
    async (
      { params: { id }, body: { userId, role }, organizationId },
      reply,
    ) => {
      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      const member = await TeamModel.addMember(id, userId, role);

      return reply.send(member);
    },
  );

  fastify.delete(
    "/api/teams/:id/members/:userId",
    {
      schema: {
        operationId: RouteId.RemoveTeamMember,
        description: "Remove a member from a team",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
          userId: z.string(),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id, userId }, organizationId, user }, reply) => {
      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      const success = await TeamModel.removeMember(id, userId);

      if (!success) {
        throw new ApiError(404, "Team member not found");
      }

      const userIsAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });

      // Clean up invalid credential sources (personal tokens) for this user
      // if they no longer have access to agents through other teams
      try {
        const cleanedCount =
          await AgentToolModel.cleanupInvalidCredentialSourcesForUser(
            userId,
            id,
            userIsAgentAdmin,
          );

        if (cleanedCount > 0) {
          fastify.log.info(
            `Cleaned up ${cleanedCount} invalid credential sources for user ${userId}`,
          );
        }
      } catch (cleanupError) {
        // Log the error but don't fail the request
        fastify.log.error(cleanupError, "Error cleaning up credential sources");
      }

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/teams/:id/external-groups",
    {
      schema: {
        operationId: RouteId.GetTeamExternalGroups,
        description:
          "Get all external groups mapped to a team for SSO team sync",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(
          z.array(SelectTeamExternalGroupSchema),
        ),
      },
    },
    async ({ params: { id }, organizationId, user, headers }, reply) => {
      // Verify enterprise license
      if (!config.enterpriseFeatures.core) {
        throw new ApiError(
          403,
          "Team Sync is an enterprise feature. Please contact sales@archestra.ai to enable it.",
        );
      }

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user is team:admin or member of the team
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );
      if (!isTeamAdmin) {
        const isMember = await TeamModel.isUserInTeam(id, user.id);
        if (!isMember) {
          throw new ApiError(404, "Team not found");
        }
      }

      return reply.send(await TeamModel.getExternalGroups(id));
    },
  );

  fastify.post(
    "/api/teams/:id/external-groups",
    {
      schema: {
        operationId: RouteId.AddTeamExternalGroup,
        description:
          "Add an external group mapping to a team for SSO team sync",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
        }),
        body: AddTeamExternalGroupBodySchema,
        response: constructResponseSchema(SelectTeamExternalGroupSchema),
      },
    },
    async (
      { params: { id }, body: { groupIdentifier }, organizationId },
      reply,
    ) => {
      // Verify enterprise license
      if (!config.enterpriseFeatures.core) {
        throw new ApiError(
          403,
          "Team Sync is an enterprise feature. Please contact sales@archestra.ai to enable it.",
        );
      }

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Normalize group identifier to lowercase for case-insensitive matching
      const normalizedGroupIdentifier = groupIdentifier.toLowerCase();

      // Check if the mapping already exists
      const existingGroups = await TeamModel.getExternalGroups(id);
      if (
        existingGroups.some(
          (g) => g.groupIdentifier.toLowerCase() === normalizedGroupIdentifier,
        )
      ) {
        throw new ApiError(
          409,
          "This external group is already mapped to this team",
        );
      }

      const externalGroup = await TeamModel.addExternalGroup(
        id,
        normalizedGroupIdentifier,
      );

      return reply.send(externalGroup);
    },
  );

  fastify.delete(
    "/api/teams/:id/external-groups/:groupId",
    {
      schema: {
        operationId: RouteId.RemoveTeamExternalGroup,
        description:
          "Remove an external group mapping from a team for SSO team sync",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
          groupId: z.string(),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id, groupId }, organizationId }, reply) => {
      // Verify enterprise license
      if (!config.enterpriseFeatures.core) {
        throw new ApiError(
          403,
          "Team Sync is an enterprise feature. Please contact sales@archestra.ai to enable it.",
        );
      }

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      const success = await TeamModel.removeExternalGroupById(id, groupId);

      if (!success) {
        throw new ApiError(404, "External group mapping not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default teamRoutes;
