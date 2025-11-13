import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import logger from "@/logging";
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
  constructResponseSchema,
  InsertMcpServerSchema,
  type InternalMcpCatalogServerType,
  LocalMcpServerInstallationStatusSchema,
  SelectMcpServerSchema,
  UuidIdSchema,
} from "@/types";

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
        response: constructResponseSchema(z.array(SelectMcpServerSchema)),
      },
    },
    async (request, reply) => {
      try {
        const { success: isMcpServerAdmin } = await hasPermission(
          { mcpServer: ["admin"] },
          request.headers,
        );
        const allServers = await McpServerModel.findAll(
          request.user.id,
          isMcpServerAdmin,
        );
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
        response: constructResponseSchema(SelectMcpServerSchema),
      },
    },
    async (request, reply) => {
      try {
        const server = await McpServerModel.findById(
          request.params.id,
          request.user.id,
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
          serverType: true, // derived from catalog item
        }).extend({
          agentIds: z.array(UuidIdSchema).optional(),
          secretId: UuidIdSchema.optional(),
          // For PAT tokens (like GitHub), send the token directly
          // and we'll create a secret for it
          accessToken: z.string().optional(),
        }),
        response: constructResponseSchema(SelectMcpServerSchema),
      },
    },
    async (request, reply) => {
      try {
        const { user, headers } = request;
        let {
          agentIds,
          secretId,
          accessToken,
          userConfigValues,
          environmentValues,
          ...restDataFromRequestBody
        } = request.body;
        const serverData: typeof restDataFromRequestBody & {
          serverType: InternalMcpCatalogServerType;
        } = {
          ...restDataFromRequestBody,
          serverType: "local",
        };

        // Set owner_id to current user
        serverData.ownerId = user.id;

        // Determine auth type and set userId for personal auth
        if (!serverData.teams || serverData.teams.length === 0) {
          serverData.authType = "personal";
          serverData.userId = user.id;
        } else {
          const { success: isMcpServerAdmin } = await hasPermission(
            { mcpServer: ["admin"] },
            headers,
          );

          // Team installation requires MCP server admin role
          if (!isMcpServerAdmin) {
            return reply.status(403).send({
              error: {
                message:
                  "Only MCP server admins can install MCP servers for teams",
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

        // Fetch catalog item to get server type
        let catalogItem = null;
        if (serverData.catalogId) {
          catalogItem = await InternalMcpCatalogModel.findById(
            serverData.catalogId,
          );

          if (!catalogItem) {
            return reply.status(400).send({
              error: {
                message: "Catalog item not found",
                type: "validation_error",
              },
            });
          }

          // Set serverType from catalog item
          serverData.serverType = catalogItem.serverType;

          // For local servers, filter out secret-type env vars and store in database
          if (
            catalogItem.serverType === "local" &&
            catalogItem.localConfig?.environment
          ) {
            const secretEnvVars: Record<string, string> = {};

            // Collect all secret-type env vars (both static and prompted)
            for (const envDef of catalogItem.localConfig.environment) {
              if (envDef.type === "secret") {
                let value: string | undefined;
                // Get value based on whether it's prompted or static
                if (envDef.promptOnInstallation) {
                  // Prompted during installation - get from environmentValues
                  value = environmentValues?.[envDef.key];
                } else {
                  // Static value from catalog - get from envDef.value
                  value = envDef.value;
                }
                // Add to secret if value exists
                if (value) {
                  secretEnvVars[envDef.key] = value;
                }
              }
            }

            // Create secret in database if there are any secret env vars
            if (Object.keys(secretEnvVars).length > 0) {
              const secret =
                await SecretModel.createMcpServerSecret(secretEnvVars);
              secretId = secret.id;
              createdSecretId = secret.id;
              logger.info(
                {
                  secretId: secret.id,
                  envVarCount: Object.keys(secretEnvVars).length,
                },
                "Created secret for local MCP server environment variables",
              );
            }
          }
        }

        // Create the MCP server with optional secret reference
        const mcpServer = await McpServerModel.create({
          ...serverData,
          ...(secretId && { secretId }),
        });

        try {
          // For local servers, start the K8s pod first
          if (catalogItem?.serverType === "local") {
            try {
              // Capture catalogId before async callback to ensure it's available
              const capturedCatalogId = catalogItem.id;
              const capturedCatalogName = catalogItem.name;

              // Set status to pending before starting the pod
              await McpServerModel.update(mcpServer.id, {
                localInstallationStatus: "pending",
                localInstallationError: null,
              });

              await McpServerRuntimeManager.startServer(
                mcpServer,
                userConfigValues,
                environmentValues,
              );
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

                  // Wait for the pod to be fully ready (MCP server process needs time to initialize)
                  await new Promise((resolve) => setTimeout(resolve, 10000));
                  fastify.log.info(
                    `Attempting to fetch tools from local server: ${mcpServer.name}`,
                  );
                  const tools =
                    await McpServerModel.getToolsFromServer(mcpServer);

                  // Persist tools in the database
                  // Use catalog item name (without userId) for tool naming to avoid duplicates across users
                  const toolNamePrefix = capturedCatalogName || mcpServer.name;
                  for (const tool of tools) {
                    // Use createToolIfNotExists to avoid duplicates when multiple users install the same server
                    const createdTool = await ToolModel.createToolIfNotExists({
                      name: ToolModel.slugifyName(toolNamePrefix, tool.name),
                      description: tool.description,
                      parameters: tool.inputSchema,
                      catalogId: capturedCatalogId,
                      mcpServerId: mcpServer.id,
                    });

                    // If agentIds were provided, create agent-tool assignments with executionSourceMcpServerId
                    if (agentIds && agentIds.length > 0) {
                      for (const agentId of agentIds) {
                        await AgentToolModel.create(agentId, createdTool.id, {
                          executionSourceMcpServerId: mcpServer.id,
                        });
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
                  // then after 5secs, delete the MCP server record
                  setTimeout(async () => {
                    await McpServerModel.delete(mcpServer.id);
                  }, 5000);
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

          // Catalog item must exist for remote servers
          if (!catalogItem) {
            throw new Error("Catalog item not found for remote server");
          }

          // Persist tools in the database with source='mcp_server' and mcpServerId
          // Note: For remote servers, mcpServer.name doesn't include userId, so we can use it directly
          for (const tool of tools) {
            const createdTool = await ToolModel.createToolIfNotExists({
              name: ToolModel.slugifyName(mcpServer.name, tool.name),
              description: tool.description,
              parameters: tool.inputSchema,
              catalogId: catalogItem.id,
              mcpServerId: mcpServer.id,
            });

            // If agentIds were provided, create agent-tool assignments
            // Note: Remote servers don't use executionSourceMcpServerId (they route via HTTP)
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      try {
        const mcpServerId = request.params.id;

        // Fetch the MCP server first to get secretId and serverType
        const mcpServer = await McpServerModel.findById(mcpServerId);

        if (!mcpServer) {
          return reply.status(404).send({
            error: {
              message: "MCP server not found",
              type: "not_found",
            },
          });
        }

        // For local servers, stop the server (this will delete the K8s Secret)
        if (mcpServer.serverType === "local") {
          try {
            await McpServerRuntimeManager.stopServer(mcpServerId);
            logger.info(
              { mcpServerId },
              "Stopped K8s pod and deleted K8s Secret for local MCP server",
            );
          } catch (error) {
            logger.error(
              { err: error, mcpServerId },
              "Failed to stop local MCP server pod",
            );
            // Continue with deletion even if pod stop fails
          }
        }

        // Delete database secret if it exists and is for a local server
        // (don't delete OAuth tokens for remote servers)
        if (mcpServer.secretId && mcpServer.serverType === "local") {
          try {
            await SecretModel.deleteMcpServerSecret(mcpServer.secretId);
            logger.info(
              { secretId: mcpServer.secretId, mcpServerId },
              "Deleted database secret for local MCP server",
            );
          } catch (error) {
            logger.error(
              { err: error, secretId: mcpServer.secretId },
              "Failed to delete database secret",
            );
            // Continue with MCP server deletion even if secret deletion fails
          }
        }

        // Delete the MCP server record
        const success = await McpServerModel.delete(mcpServerId);

        return reply.send({ success });
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
        response: constructResponseSchema(
          z.object({
            localInstallationStatus: LocalMcpServerInstallationStatusSchema,
            localInstallationError: z.string().nullable(),
          }),
        ),
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
        response: constructResponseSchema(
          z.array(
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
        ),
      },
    },
    async (request, reply) => {
      try {
        // Get the MCP server first to check if it has a catalogId
        const mcpServer = await McpServerModel.findById(request.params.id);

        if (!mcpServer) {
          return reply.status(404).send({
            error: {
              message: "MCP server not found",
              type: "not_found_error",
            },
          });
        }

        // For catalog-based servers (local installations), query tools by catalogId
        // This ensures all installations of the same catalog show the same tools
        // For legacy servers without catalogId, fall back to mcpServerId
        const tools = mcpServer.catalogId
          ? await ToolModel.findByCatalogId(mcpServer.catalogId)
          : await ToolModel.findByMcpServerId(request.params.id);

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
          follow: z.coerce.boolean().optional().default(false),
        }),
        response: constructResponseSchema(
          z.object({
            logs: z.string(),
            containerName: z.string(),
            command: z.string(),
            namespace: z.string(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { id: mcpServerId } = request.params;
      const { lines, follow } = request.query;

      try {
        // If follow is enabled, stream the logs
        if (follow) {
          // Hijack the response to handle streaming
          reply.hijack();
          reply.raw.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache",
            "Transfer-Encoding": "chunked",
          });

          await McpServerRuntimeManager.streamMcpServerLogs(
            mcpServerId,
            reply.raw,
            lines,
          );

          return;
        }

        // Otherwise, return logs as usual
        const logs = await McpServerRuntimeManager.getMcpServerLogs(
          mcpServerId,
          lines,
        );
        return reply.send(logs);
      } catch (error) {
        fastify.log.error(
          `Error getting logs for MCP server ${mcpServerId}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );

        // If we've already hijacked, we can't send a normal error response
        if (follow && reply.raw.headersSent) {
          reply.raw.end();
          return;
        }

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
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            message: z.string(),
          }),
        ),
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      try {
        const { user } = request;
        const { catalogId } = request.params;
        const { userId: targetUserId } = request.body;

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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      try {
        const { user } = request;
        const { catalogId } = request.params;

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
