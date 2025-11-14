import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { AgentToolModel, TeamModel } from "@/models";
import {
  AddTeamMemberBodySchema,
  CreateTeamBodySchema,
  constructResponseSchema,
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
      try {
        return reply.send(
          await TeamModel.findByOrganization(request.organizationId),
        );
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
      try {
        return reply.send(
          await TeamModel.create({
            name,
            description,
            organizationId,
            createdBy: user.id,
          }),
        );
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
      try {
        const team = await TeamModel.findById(id);

        if (!team) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        // Verify the team belongs to the user's organization
        if (team.organizationId !== organizationId) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        return reply.send(team);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
      try {
        // Verify the team exists and belongs to the user's organization
        const existingTeam = await TeamModel.findById(id);
        if (!existingTeam || existingTeam.organizationId !== organizationId) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        const team = await TeamModel.update(id, body);

        if (!team) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        return reply.send(team);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      try {
        // Verify the team exists and belongs to the user's organization
        const existingTeam = await TeamModel.findById(id);
        if (!existingTeam || existingTeam.organizationId !== organizationId) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        const success = await TeamModel.delete(id);

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
      try {
        // Verify the team exists and belongs to the user's organization
        const team = await TeamModel.findById(id);
        if (!team || team.organizationId !== organizationId) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        return reply.send(await TeamModel.getTeamMembers(id));
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
    async ({ params: { id }, body, organizationId }, reply) => {
      try {
        // Verify the team exists and belongs to the user's organization
        const team = await TeamModel.findById(id);
        if (!team || team.organizationId !== organizationId) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        const member = await TeamModel.addMember(id, body.userId, body.role);

        return reply.send(member);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id, userId }, organizationId, headers }, reply) => {
      try {
        // Verify the team exists and belongs to the user's organization
        const team = await TeamModel.findById(id);
        if (!team || team.organizationId !== organizationId) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        const success = await TeamModel.removeMember(id, userId);

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Team member not found",
              type: "not_found",
            },
          });
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
          fastify.log.error(
            cleanupError,
            "Error cleaning up credential sources",
          );
        }

        return reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );
};

export default teamRoutes;
