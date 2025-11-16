import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { AgentToolModel, TeamModel } from "@/models";
import {
  AddTeamMemberBodySchema,
  ApiError,
  CreateTeamBodySchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
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
    async ({ params: { id }, organizationId }, reply) => {
      const team = await TeamModel.findById(id);

      if (!team) {
        throw new ApiError(404, "Team not found");
      }

      // Verify the team belongs to the user's organization
      if (team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
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
    async ({ params: { id }, body, organizationId }, reply) => {
      // Verify the team exists and belongs to the user's organization
      const existingTeam = await TeamModel.findById(id);
      if (!existingTeam || existingTeam.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
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
    async ({ params: { id }, organizationId }, reply) => {
      // Verify the team exists and belongs to the user's organization
      const existingTeam = await TeamModel.findById(id);
      if (!existingTeam || existingTeam.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
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
    async ({ params: { id }, organizationId }, reply) => {
      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(id);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
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
};

export default teamRoutes;
