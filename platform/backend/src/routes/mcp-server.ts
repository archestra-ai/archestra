import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AgentToolModel,
  McpServerModel,
  McpServerTeamModel,
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
        querystring: z.object({
          authType: z.enum(["personal", "team"]).optional(),
        }),
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

        const allServers = await McpServerModel.findAll(user.id, user.isAdmin);
        const { authType } = request.query;

        // Filter by authType if provided
        const filteredServers = authType
          ? allServers.filter((server) => server.authType === authType)
          : allServers;

        return reply.send(filteredServers);
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
          403: ErrorResponseSchema,
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

        // Set owner_id to current user
        serverData.ownerId = user.id;

        // Determine auth type and set userId for personal auth
        if (!serverData.teams || serverData.teams.length === 0) {
          serverData.authType = "personal";
          serverData.userId = user.id;
        } else {
          // Team installation requires admin role
          if (!user.isAdmin) {
            return reply.status(403).send({
              error: {
                message: "Only admins can install MCP servers for teams",
                type: "forbidden",
              },
            });
          }
          serverData.authType = "team";
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
    "/api/mcp_server/catalog/:catalogId/user/:userId",
    {
      schema: {
        operationId: RouteId.RevokeUserMcpServerAccess,
        description:
          "Revoke a user's personal access to an MCP server by finding their personal-auth installation",
        tags: ["MCP Server"],
        params: z.object({
          catalogId: UuidIdSchema,
          userId: z.string(),
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
        const { catalogId, userId } = request.params;

        // Find all servers with this catalogId
        const serversForCatalog =
          await McpServerModel.findByCatalogId(catalogId);

        // Find the personal-auth server owned by this user
        const personalServer = serversForCatalog.find(
          (s) => s.authType === "personal" && s.ownerId === userId,
        );

        if (!personalServer) {
          return reply.status(404).send({
            error: {
              message:
                "Personal MCP server installation not found for this user",
              type: "not_found",
            },
          });
        }

        // Delete the personal-auth server (which will cascade delete the secret and mcp_server_user entries)
        await McpServerModel.delete(personalServer.id);

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

  // Grant team access to MCP server
  fastify.post(
    "/api/mcp_server/catalog/:catalogId/teams",
    {
      schema: {
        operationId: RouteId.GrantTeamMcpServerAccess,
        description:
          "Grant team(s) access to an MCP server using current user's team-auth token (admin only)",
        tags: ["MCP Server"],
        params: z.object({
          catalogId: UuidIdSchema,
        }),
        body: z.object({
          teamIds: z.array(z.string()).min(1),
          userId: z.string().optional(), // Optional: specify which admin's token to use
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { catalogId } = request.params;
        const { userId: targetUserId } = request.body;

        // Get the current user
        const user = await getUserFromRequest(request);
        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Use the specified userId or default to current user
        const ownerIdToUse = targetUserId || user.id;

        // Find all servers with this catalogId
        const serversForCatalog =
          await McpServerModel.findByCatalogId(catalogId);

        // Find the team-auth server owned by the specified user
        const teamServer = serversForCatalog.find(
          (s) => s.authType === "team" && s.ownerId === ownerIdToUse,
        );

        if (!teamServer) {
          const errorMsg = targetUserId
            ? `Team authentication not found for the specified admin.`
            : `Team authentication not found. You must install with team authentication first.`;
          return reply.status(404).send({
            error: {
              message: errorMsg,
              type: "not_found",
            },
          });
        }

        // Assign teams to the MCP server
        await McpServerTeamModel.assignTeamsToMcpServer(
          teamServer.id,
          request.body.teamIds,
        );

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

  // Revoke all team access for a catalog (delete team-auth server)
  fastify.delete(
    "/api/mcp_server/catalog/:catalogId/teams",
    {
      schema: {
        operationId: RouteId.RevokeAllTeamsMcpServerAccess,
        description:
          "Revoke all team access to an MCP server by deleting the team-auth installation",
        tags: ["MCP Server"],
        params: z.object({
          catalogId: UuidIdSchema,
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { catalogId } = request.params;

        // Get the current user
        const user = await getUserFromRequest(request);
        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Find all servers with this catalogId
        const serversForCatalog =
          await McpServerModel.findByCatalogId(catalogId);

        // Find the team-auth server owned by current user
        const teamServer = serversForCatalog.find(
          (s) => s.authType === "team" && s.ownerId === user.id,
        );

        if (!teamServer) {
          return reply.status(404).send({
            error: {
              message: "Team MCP server installation not found",
              type: "not_found",
            },
          });
        }

        // Delete the team-auth server (which will cascade delete the secret and all mcp_server_team entries)
        await McpServerModel.delete(teamServer.id);

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
