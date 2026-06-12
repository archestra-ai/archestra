import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission, hasPermission } from "@/auth";
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
  SelectTeamMemberListItemSchema,
  SelectTeamMemberSchema,
  SelectTeamSchema,
  UpdateTeamBodySchema,
  UpdateTeamMemberBodySchema,
} from "@/types";

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
          // When true, always return only the teams the caller is a member of,
          // even for organization-level team managers. Resource
          // team-assignment pickers use this so a manager who isn't a member of
          // a team isn't offered teams they can't actually assign to.
          mine: z
            .preprocess((val) => val === "true" || val === true, z.boolean())
            .optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectTeamSchema),
        ),
      },
    },
    async (request, reply) => {
      const { limit, offset, name, mine } = request.query;
      const { success: canManageAllTeams } = await hasPermission(
        { team: ["create"] },
        request.headers,
      );

      // Members (and anyone passing ?mine) only see teams they belong to.
      if (!canManageAllTeams || mine) {
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
      // Organization-level team managers see all teams in the organization
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

      const { success: canManageAllTeams } = await hasPermission(
        { team: ["create"] },
        headers,
      );
      if (!canManageAllTeams) {
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
    async ({ params: { id }, body, organizationId, headers }, reply) => {
      // Verify the team exists and belongs to the user's organization
      const existingTeam = await TeamModel.findById(id);
      if (!existingTeam || existingTeam.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      const { success: canUpdateTeams } = await hasPermission(
        { team: ["update"] },
        headers,
      );

      if (!canUpdateTeams) {
        throw new ApiError(403, "You are not authorized to update this team");
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
    async ({ params: { id }, organizationId, headers }, reply) => {
      // Verify the team exists and belongs to the user's organization
      const existingTeam = await TeamModel.findById(id);
      if (!existingTeam || existingTeam.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      const { success: canDeleteTeams } = await hasPermission(
        { team: ["delete"] },
        headers,
      );

      if (!canDeleteTeams) {
        throw new ApiError(403, "You are not authorized to delete this team");
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

      const { success: canManageAllTeams } = await hasPermission(
        { team: ["create"] },
        headers,
      );
      if (!canManageAllTeams) {
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
      { params: { id }, body: { userId, role }, organizationId, user, headers },
      reply,
    ) => {
      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      await assertCanManageTeam({
        teamId: id,
        userId: user.id,
        headers,
        action: "manage team members",
      });

      const isMember = await TeamModel.isUserInTeam(id, userId);
      if (isMember) {
        throw new ApiError(409, "User is already a member of this team");
      }

      const member = await TeamModel.addMember(id, userId, role);

      return reply.send(member);
    },
  );

  fastify.put(
    "/api/teams/:id/members/:userId",
    {
      schema: {
        operationId: RouteId.UpdateTeamMember,
        description: "Update a team member role",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
          userId: z.string(),
        }),
        body: UpdateTeamMemberBodySchema,
        response: constructResponseSchema(SelectTeamMemberSchema),
      },
    },
    async (
      { params: { id, userId }, body: { role }, organizationId, user, headers },
      reply,
    ) => {
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      await assertCanManageTeam({
        teamId: id,
        userId: user.id,
        headers,
        action: "manage team member roles",
      });

      await assertNotRemovingLastTeamAdmin({
        teamId: id,
        userId,
        nextRole: role,
      });

      const member = await TeamModel.updateMemberRole({
        teamId: id,
        userId,
        role,
      });

      if (!member) {
        throw new ApiError(404, "Team member not found");
      }

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
    async (
      { params: { id, userId }, organizationId, user, headers },
      reply,
    ) => {
      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      await assertCanManageTeam({
        teamId: id,
        userId: user.id,
        headers,
        action: "manage team members",
      });

      await assertNotRemovingLastTeamAdmin({
        teamId: id,
        userId,
        nextRole: null,
      });

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

      const { success: canManageAllTeams } = await hasPermission(
        { team: ["create"] },
        headers,
      );
      if (!canManageAllTeams) {
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
      {
        params: { id },
        body: { groupIdentifier },
        organizationId,
        user,
        headers,
      },
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

      await assertCanManageTeam({
        teamId: id,
        userId: user.id,
        headers,
        action: "manage team external group sync",
      });

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
    async (
      { params: { id, groupId }, organizationId, user, headers },
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

      await assertCanManageTeam({
        teamId: id,
        userId: user.id,
        headers,
        action: "manage team external group sync",
      });

      const success = await TeamModel.removeExternalGroupById(id, groupId);

      if (!success) {
        throw new ApiError(404, "External group mapping not found");
      }

      return reply.send({ success: true });
    },
  );
};

export default teamRoutes;

async function assertCanManageTeam(params: {
  teamId: string;
  userId: string;
  headers: Parameters<typeof hasPermission>[1];
  action: string;
}) {
  const { success: canManageAllTeams } = await hasPermission(
    { team: ["create"] },
    params.headers,
  );

  if (canManageAllTeams) {
    return;
  }

  const isTeamAdmin = await TeamModel.isUserTeamAdmin(
    params.teamId,
    params.userId,
  );

  if (!isTeamAdmin) {
    throw new ApiError(403, `You must be a team admin to ${params.action}`);
  }
}

async function assertNotRemovingLastTeamAdmin(params: {
  teamId: string;
  userId: string;
  nextRole: "admin" | "member" | null;
}) {
  const members = await TeamModel.getTeamMembers(params.teamId);
  const targetMember = members.find(
    (member) => member.userId === params.userId,
  );

  if (!targetMember) {
    throw new ApiError(404, "Team member not found");
  }

  if (targetMember.role !== "admin" || params.nextRole === "admin") {
    return;
  }

  const adminCount = members.filter((member) => member.role === "admin").length;
  if (adminCount <= 1) {
    throw new ApiError(400, "Cannot remove the last admin from a team");
  }
}
