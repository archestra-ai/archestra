import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import {
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  McpServerTeamModel,
  SecretModel,
  ToolModel,
} from "@/models";
import {
  ErrorResponseSchema,
  InsertMcpServerSchema,
  LocalMcpServerInstallationStatusSchema,
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
        querystring: z.object({
          authType: z.enum(["personal", "team"]).optional(),
        }),
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
          // Check if this is a local server that needs to be started in K8s
          let catalogItem = null;
          if (serverData.catalogId) {
            catalogItem = await InternalMcpCatalogModel.findById(
              serverData.catalogId,
            );
          }

          // For local servers, start the K8s pod first
          if (catalogItem?.serverType === "local") {
            try {
              // Set status to pending before starting the pod
              await McpServerModel.update(mcpServer.id, {
                localInstallationStatus: "pending",
                localInstallationError: null,
              });

              await McpServerRuntimeManager.startServer(mcpServer);
              fastify.log.info(
                `Started K8s pod for local MCP server: ${mcpServer.name}`,
              );

              // For local servers, return immediately without waiting for tools
              // Tools will be fetched asynchronously after the pod is ready
              fastify.log.info(
                `Skipping synchronous tool fetch for local server: ${mcpServer.name}. Tools will be fetched asynchronously.`,
              );

              // Start async tool fetching in the background (non-blocking)
              (async () => {
                try {
                  await McpServerModel.update(mcpServer.id, {
                    localInstallationStatus: "discovering-tools",
                    localInstallationError: null,
                  });

                  // Wait a bit for the pod to be fully ready
                  await new Promise((resolve) => setTimeout(resolve, 3000));
                  fastify.log.info(
                    `Attempting to fetch tools from local server: ${mcpServer.name}`,
                  );
                  const tools =
                    await McpServerModel.getToolsFromServer(mcpServer);

                  // Persist tools in the database
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

                  // Set status to success after tools are fetched
                  await McpServerModel.update(mcpServer.id, {
                    localInstallationStatus: "success",
                    localInstallationError: null,
                  });

                  fastify.log.info(
                    `Successfully fetched and persisted ${tools.length} tools from local server: ${mcpServer.name}`,
                  );
                } catch (toolError) {
                  const errorMessage =
                    toolError instanceof Error
                      ? toolError.message
                      : "Unknown error";
                  fastify.log.error(
                    `Failed to fetch tools from local server ${mcpServer.name}: ${errorMessage}`,
                  );

                  // Set status to error if tool fetching fails
                  await McpServerModel.update(mcpServer.id, {
                    localInstallationStatus: "error",
                    localInstallationError: errorMessage,
                  });
                }
              })();

              // Return the MCP server with pending status
              return reply.send({
                ...mcpServer,
                localInstallationStatus: "pending",
                localInstallationError: null,
              });
            } catch (podError) {
              // If pod fails to start, delete the MCP server record
              await McpServerModel.delete(mcpServer.id);
              throw new Error(
                `Failed to start K8s pod for MCP server: ${podError instanceof Error ? podError.message : "Unknown error"}`,
              );
            }
          }

          // For non-local servers, fetch tools synchronously during installation
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

          // Set status to success for non-local servers
          await McpServerModel.update(mcpServer.id, {
            localInstallationStatus: "success",
            localInstallationError: null,
          });

          return reply.send({
            ...mcpServer,
            localInstallationStatus: "success",
            localInstallationError: null,
          });
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
    "/api/mcp_server/:id/installation-status",
    {
      schema: {
        operationId: RouteId.GetMcpServerInstallationStatus,
        description:
          "Get the installation status of an MCP server (for polling during local server installation)",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: z.object({
            localInstallationStatus: LocalMcpServerInstallationStatusSchema,
            localInstallationError: z.string().nullable(),
          }),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const mcpServer = await McpServerModel.findById(request.params.id);

        if (!mcpServer) {
          return reply.status(404).send({
            error: {
              message: "MCP server not found",
              type: "not_found",
            },
          });
        }

        return reply.send({
          localInstallationStatus: mcpServer.localInstallationStatus || "idle",
          localInstallationError: mcpServer.localInstallationError || null,
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

  fastify.get(
    "/api/mcp_server/:id/logs",
    {
      schema: {
        operationId: RouteId.GetMcpServerLogs,
        description: "Get logs for a specific MCP server pod",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
        }),
        querystring: z.object({
          lines: z.coerce.number().optional().default(100),
        }),
        response: {
          200: z.object({
            logs: z.string(),
            containerName: z.string(),
            command: z.string(),
            namespace: z.string(),
          }),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id: mcpServerId } = request.params;
      const { lines } = request.query;

      try {
        const logs = await McpServerRuntimeManager.getMcpServerLogs(
          mcpServerId,
          lines,
        );
        return reply.send(logs);
      } catch (error) {
        fastify.log.error(
          `Error getting logs for MCP server ${mcpServerId}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        return reply.status(404).send({
          error: {
            message:
              error instanceof Error ? error.message : "Failed to get logs",
            type: "not_found",
          },
        });
      }
    },
  );

  fastify.post(
    "/api/mcp_server/:id/restart",
    {
      schema: {
        operationId: RouteId.RestartMcpServer,
        description: "Restart a single MCP server pod",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id: mcpServerId } = request.params;

      try {
        await McpServerRuntimeManager.restartServer(mcpServerId);
        return reply.send({
          success: true,
          message: `MCP server ${mcpServerId} restarted successfully`,
        });
      } catch (error) {
        fastify.log.error(
          `Failed to restart MCP server ${mcpServerId}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );

        if (error instanceof Error && error.message?.includes("not found")) {
          return reply.status(404).send({
            error: {
              message: error.message,
              type: "not_found",
            },
          });
        }

        return reply.status(500).send({
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Failed to restart MCP server",
            type: "api_error",
          },
        });
      }
    },
  );

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

  fastify.post(
    "/mcp_proxy/:id",
    {
      schema: {
        hide: true,
        description:
          "Proxy requests to the MCP server running in a Kubernetes pod",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z
          .object({
            jsonrpc: z.string().optional(),
            id: z.union([z.string(), z.number()]).optional(),
            method: z.string().optional(),
            params: z.any().optional(),
            sessionId: z.string().optional(),
            mcpSessionId: z.string().optional(),
          })
          .passthrough(),
      },
    },
    async (request, reply) => {
      const { id: mcpServerId } = request.params;
      const body = request.body;

      try {
        // Get the MCP server from database
        const mcpServer = await McpServerModel.findById(mcpServerId);
        if (!mcpServer) {
          return reply.status(404).send({
            error: {
              message: "MCP server not found",
              type: "not_found",
            },
          });
        }

        // Check if this is a local server that should be running in K8s
        let catalogItem = null;
        if (mcpServer.catalogId) {
          catalogItem = await InternalMcpCatalogModel.findById(
            mcpServer.catalogId,
          );
        }

        // Only handle local servers through the proxy
        if (catalogItem?.serverType !== "local") {
          return reply.status(400).send({
            error: {
              message:
                "This endpoint is only for local MCP servers running in K8s",
              type: "validation_error",
            },
          });
        }

        // Get the K8s pod for this MCP server
        const k8sPod = McpServerRuntimeManager.getPod(mcpServerId);

        if (!k8sPod) {
          return reply.status(404).send({
            error: {
              message: "MCP server pod not found or not running",
              type: "not_found",
            },
          });
        }

        // Hijack the response to handle streaming manually
        reply.hijack();

        // Set up streaming response headers
        reply.raw.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        });

        // Stream the request to the pod
        await McpServerRuntimeManager.streamToPod(
          mcpServerId,
          body,
          // biome-ignore lint/suspicious/noExplicitAny: TODO: fix this type..
          reply.raw as any,
        );

        // Return undefined when hijacking to prevent Fastify from sending response
        return;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        fastify.log.error(
          `Error proxying to MCP server ${mcpServerId}: ${errorMsg}`,
        );

        // If we haven't sent yet, we can still send error response
        if (!reply.sent) {
          return reply.status(500).send({
            error: {
              message: errorMsg,
              type: "api_error",
            },
          });
        } else if (!reply.raw.headersSent) {
          // If already hijacked, try to write error to raw response
          reply.raw.writeHead(500, { "Content-Type": "application/json" });
          reply.raw.end(
            JSON.stringify({
              error: {
                message: errorMsg,
                type: "api_error",
              },
            }),
          );
        }
      }
    },
  );
};

export default mcpServerRoutes;
