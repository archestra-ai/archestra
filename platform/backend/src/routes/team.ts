import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { TeamModel } from "@/models";
import {
  AddTeamMemberBodySchema,
  CreateTeamBodySchema,
  ErrorResponseSchema,
  RouteId,
  SelectTeamMemberSchema,
  SelectTeamSchema,
  UpdateTeamBodySchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";

const teamRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get all teams in the organization
   */
  fastify.get(
    "/api/teams",
    {
      schema: {
        operationId: RouteId.GetTeams,
        description: "Get all teams in the organization",
        tags: ["Teams"],
        response: {
          200: z.array(SelectTeamSchema),
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const teams = await TeamModel.findByOrganization(user.organizationId);
        return reply.send(teams);
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

  /**
   * Create a new team (Admin only)
   */
  fastify.post(
    "/api/teams",
    {
      schema: {
        operationId: RouteId.CreateTeam,
        description: "Create a new team (Admin only)",
        tags: ["Teams"],
        body: CreateTeamBodySchema,
        response: {
          200: SelectTeamSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can create teams",
              type: "forbidden",
            },
          });
        }

        const team = await TeamModel.create({
          name: request.body.name,
          description: request.body.description,
          organizationId: user.organizationId,
          createdBy: user.id,
        });

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

  /**
   * Get a team by ID
   */
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
        response: {
          200: SelectTeamSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const team = await TeamModel.findById(request.params.id);

        if (!team) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        // Verify the team belongs to the user's organization
        if (team.organizationId !== user.organizationId) {
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

  /**
   * Update a team (Admin only)
   */
  fastify.put(
    "/api/teams/:id",
    {
      schema: {
        operationId: RouteId.UpdateTeam,
        description: "Update a team (Admin only)",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
        }),
        body: UpdateTeamBodySchema,
        response: {
          200: SelectTeamSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can update teams",
              type: "forbidden",
            },
          });
        }

        // Verify the team exists and belongs to the user's organization
        const existingTeam = await TeamModel.findById(request.params.id);
        if (
          !existingTeam ||
          existingTeam.organizationId !== user.organizationId
        ) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        const team = await TeamModel.update(request.params.id, request.body);

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

  /**
   * Delete a team (Admin only)
   */
  fastify.delete(
    "/api/teams/:id",
    {
      schema: {
        operationId: RouteId.DeleteTeam,
        description: "Delete a team (Admin only)",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can delete teams",
              type: "forbidden",
            },
          });
        }

        // Verify the team exists and belongs to the user's organization
        const existingTeam = await TeamModel.findById(request.params.id);
        if (
          !existingTeam ||
          existingTeam.organizationId !== user.organizationId
        ) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        const success = await TeamModel.delete(request.params.id);

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

  /**
   * Get team members
   */
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
        response: {
          200: z.array(SelectTeamMemberSchema),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Verify the team exists and belongs to the user's organization
        const team = await TeamModel.findById(request.params.id);
        if (!team || team.organizationId !== user.organizationId) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        const members = await TeamModel.getTeamMembers(request.params.id);
        return reply.send(members);
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

  /**
   * Add a member to a team (Admin only)
   */
  fastify.post(
    "/api/teams/:id/members",
    {
      schema: {
        operationId: RouteId.AddTeamMember,
        description: "Add a member to a team (Admin only)",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
        }),
        body: AddTeamMemberBodySchema,
        response: {
          200: SelectTeamMemberSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can add team members",
              type: "forbidden",
            },
          });
        }

        // Verify the team exists and belongs to the user's organization
        const team = await TeamModel.findById(request.params.id);
        if (!team || team.organizationId !== user.organizationId) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        const member = await TeamModel.addMember(
          request.params.id,
          request.body.userId,
          request.body.role,
        );

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

  /**
   * Remove a member from a team (Admin only)
   */
  fastify.delete(
    "/api/teams/:id/members/:userId",
    {
      schema: {
        operationId: RouteId.RemoveTeamMember,
        description: "Remove a member from a team (Admin only)",
        tags: ["Teams"],
        params: z.object({
          id: z.string(),
          userId: z.string(),
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can remove team members",
              type: "forbidden",
            },
          });
        }

        // Verify the team exists and belongs to the user's organization
        const team = await TeamModel.findById(request.params.id);
        if (!team || team.organizationId !== user.organizationId) {
          return reply.status(404).send({
            error: {
              message: "Team not found",
              type: "not_found",
            },
          });
        }

        const success = await TeamModel.removeMember(
          request.params.id,
          request.params.userId,
        );

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Team member not found",
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
};

export default teamRoutes;
