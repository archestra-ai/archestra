import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AgentToolModel,
  McpServerModel,
  McpServerTeamModel,
  McpServerUserModel,
  SecretModel,
  ToolModel,
} from "@/models";
import {
  ErrorResponseSchema,
  InsertMcpServerSchema,
  RouteId,
  SelectMcpServerSchema,
  UuidIdSchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";

const mcpServerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/mcp_server",
    {
      schema: {
        operationId: RouteId.GetMcpServers,
        description: "Get all installed MCP servers",
        tags: ["MCP Server"],
        response: {
          200: z.array(SelectMcpServerSchema),
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

        return reply.send(await McpServerModel.findAll(user.id, user.isAdmin));
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
    "/api/mcp_server/:id",
    {
      schema: {
        operationId: RouteId.GetMcpServer,
        description: "Get MCP server by ID",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: SelectMcpServerSchema,
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

        const server = await McpServerModel.findById(
          request.params.id,
          user.id,
          user.isAdmin,
        );

        if (!server) {
          return reply.status(404).send({
            error: {
              message: "MCP server not found",
              type: "not_found",
            },
          });
        }

        return reply.send(server);
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
    "/api/mcp_server",
    {
      schema: {
        operationId: RouteId.InstallMcpServer,
        description: "Install an MCP server (from catalog or custom)",
        tags: ["MCP Server"],
        body: InsertMcpServerSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }).extend({
          agentIds: z.array(UuidIdSchema).optional(),
          secretId: UuidIdSchema.optional(),
          // For PAT tokens (like GitHub), send the token directly
          // and we'll create a secret for it
          accessToken: z.string().optional(),
        }),
        response: {
          200: SelectMcpServerSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        let { agentIds, secretId, accessToken, ...serverData } = request.body;

        // Get the current user for personal auth
        const user = await getUserFromRequest(request);
        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // If teams is empty, this is personal auth - add userId
        if (!serverData.teams || serverData.teams.length === 0) {
          serverData.userId = user.id;
        }

        // Track if we created a new secret (for cleanup on failure)
        let createdSecretId: string | undefined;

        // If accessToken is provided (PAT flow), create a secret for it
        if (accessToken && !secretId) {
          const secret = await SecretModel.create({
            secret: {
              access_token: accessToken,
            },
          });
          secretId = secret.id;
          createdSecretId = secret.id;
        }

        // Validate connection if secretId is provided
        if (secretId) {
          const isValid = await McpServerModel.validateConnection(
            serverData.name,
            serverData.catalogId ?? undefined,
            secretId,
          );

          if (!isValid) {
            // Clean up the secret we just created if validation fails
            if (createdSecretId) {
              await SecretModel.delete(createdSecretId);
            }

            return reply.status(400).send({
              error: {
                message:
                  "Failed to connect to MCP server with provided credentials",
                type: "validation_error",
              },
            });
          }
        }

        // Create the MCP server with optional secret reference
        const mcpServer = await McpServerModel.create({
          ...serverData,
          ...(secretId && { secretId }),
        });

        try {
          // Get real tools from the MCP server
          const tools = await McpServerModel.getToolsFromServer(mcpServer);

          // Persist tools in the database with source='mcp_server' and mcpServerId
          for (const tool of tools) {
            const createdTool = await ToolModel.create({
              name: ToolModel.slugifyName(mcpServer.name, tool.name),
              description: tool.description,
              parameters: tool.inputSchema,
              mcpServerId: mcpServer.id,
            });

            // If agentIds were provided, create agent-tool assignments
            if (agentIds && agentIds.length > 0) {
              for (const agentId of agentIds) {
                await AgentToolModel.create(agentId, createdTool.id);
              }
            }
          }

          return reply.send(mcpServer);
        } catch (toolError) {
          // If fetching/creating tools fails, clean up everything we created
          await McpServerModel.delete(mcpServer.id);

          // Also clean up the secret if we created one
          if (createdSecretId) {
            await SecretModel.delete(createdSecretId);
          }

          throw toolError;
        }
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
    "/api/mcp_server/:id",
    {
      schema: {
        operationId: RouteId.DeleteMcpServer,
        description: "Delete/uninstall an MCP server",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send({
          success: await McpServerModel.delete(request.params.id),
        });
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
    "/api/mcp_server/:id/tools",
    {
      schema: {
        operationId: RouteId.GetMcpServerTools,
        description: "Get all tools for an MCP server",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              description: z.string().nullable(),
              parameters: z.record(z.string(), z.any()),
              createdAt: z.coerce.date(),
              assignedAgentCount: z.number(),
              assignedAgents: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                }),
              ),
            }),
          ),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const tools = await ToolModel.findByMcpServerId(request.params.id);
        return reply.send(tools);
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

  // Revoke user access to MCP server
  fastify.delete(
    "/api/mcp_server/:id/user/:userId",
    {
      schema: {
        operationId: RouteId.RevokeUserMcpServerAccess,
        description:
          "Revoke a user's personal access to an MCP server (admin only)",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
          userId: z.string(),
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        // Get the MCP server to check if it's a personal installation
        const mcpServer = await McpServerModel.findById(request.params.id);

        if (!mcpServer) {
          return reply.status(404).send({
            error: {
              message: "MCP server not found",
              type: "not_found",
            },
          });
        }

        // Check if the user has access to this server
        const hasAccess =
          await McpServerUserModel.userHasPersonalMcpServerAccess(
            request.params.userId,
            request.params.id,
          );

        if (!hasAccess) {
          return reply.status(404).send({
            error: {
              message: "User access not found",
              type: "not_found",
            },
          });
        }

        // If this is a personal installation (only one user, no teams), delete the entire server
        const isPersonalInstallation =
          mcpServer.users?.length === 1 &&
          mcpServer.users[0] === request.params.userId &&
          (!mcpServer.teams || mcpServer.teams.length === 0);

        if (isPersonalInstallation) {
          // Delete the entire MCP server (which will cascade delete the secret)
          await McpServerModel.delete(request.params.id);
        } else {
          // Otherwise, just remove the user from the junction table
          await McpServerUserModel.removeUserFromMcpServer(
            request.params.id,
            request.params.userId,
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

  // Revoke team access to MCP server
  fastify.delete(
    "/api/mcp_server/:id/team/:teamId",
    {
      schema: {
        operationId: RouteId.RevokeTeamMcpServerAccess,
        description: "Revoke a team's access to an MCP server (admin only)",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
          teamId: z.string(),
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        // Get the MCP server
        const mcpServer = await McpServerModel.findById(request.params.id);

        if (!mcpServer) {
          return reply.status(404).send({
            error: {
              message: "MCP server not found",
              type: "not_found",
            },
          });
        }

        // When there are multiple installations (personal + team auth), we need to find
        // the actual server that has this team. Check all servers with the same catalogId.
        if (!mcpServer.catalogId) {
          return reply.status(404).send({
            error: {
              message: "MCP server has no catalog ID",
              type: "not_found",
            },
          });
        }

        const allServersForCatalog = await McpServerModel.findByCatalogId(
          mcpServer.catalogId,
        );

        // Find which server actually has this team
        let targetServerId: string | null = null;
        for (const server of allServersForCatalog) {
          const teams = await McpServerTeamModel.getTeamsForMcpServer(
            server.id,
          );
          if (teams.includes(request.params.teamId)) {
            targetServerId = server.id;
            break;
          }
        }

        if (!targetServerId) {
          return reply.status(404).send({
            error: {
              message: "Team access not found",
              type: "not_found",
            },
          });
        }

        // Get the target server to check if we should delete it entirely
        const targetServer = await McpServerModel.findById(targetServerId);
        if (!targetServer) {
          return reply.status(404).send({
            error: {
              message: "Target server not found",
              type: "not_found",
            },
          });
        }

        // If this is a team-only installation (only one team, no users), delete the entire server
        const isTeamOnlyInstallation =
          targetServer.teams?.length === 1 &&
          targetServer.teams[0] === request.params.teamId &&
          (!targetServer.users || targetServer.users.length === 0);

        if (isTeamOnlyInstallation) {
          // Delete the entire MCP server (which will cascade delete the secret)
          await McpServerModel.delete(targetServerId);
        } else {
          // Otherwise, just remove the team from the junction table
          await McpServerTeamModel.removeTeamFromMcpServer(
            targetServerId,
            request.params.teamId,
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

export default mcpServerRoutes;
