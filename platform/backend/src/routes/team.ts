import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import config from "@/config";
import { AgentToolModel, TeamModel } from "@/models";
import {
  AddTeamExternalGroupBodySchema,
  AddTeamMemberBodySchema,
  ApiError,
  CreateTeamBodySchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectTeamExternalGroupSchema,
  SelectTeamMemberSchema,
  SelectTeamSchema,
  UpdateTeamBodySchema,
} from "@/types";

const teamRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/teams",
    {
      schema: {
        operationId: RouteId.GetTeams,
        description: "Get all teams in the organization",
        tags: ["Teams"],
        response: constructResponseSchema(z.array(SelectTeamSchema)),
      },
    },
    async (request, reply) => {
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        request.headers,
      );

      // Non-team admins only see teams they're members of
      if (!isTeamAdmin) {
        return reply.send(await TeamModel.getUserTeams(request.user.id));
      }
      // Team admins see all teams in the organization
      return reply.send(
        await TeamModel.findByOrganization(request.organizationId),
      );
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
    async ({ body: { name, description }, user, organizationId }, reply) => {
      return reply.send(
        await TeamModel.create({
          name,
          description,
          organizationId,
          createdBy: user.id,
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
        response: constructResponseSchema(z.array(SelectTeamMemberSchema)),
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

      return reply.send(await TeamModel.getTeamMembers(id));
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
    async ({ params: { id, userId }, organizationId, headers }, reply) => {
      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      const success = await TeamModel.removeMember(id, userId);

      if (!success) {
        throw new ApiError(404, "Team member not found");
      }

      const { success: userIsAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

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
      if (!config.enterpriseLicenseActivated) {
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
      if (!config.enterpriseLicenseActivated) {
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
      if (!config.enterpriseLicenseActivated) {
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
