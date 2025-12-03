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
  ToolModel,
} from "@/models";
import { secretManager } from "@/secretsmanager";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  InsertMcpServerSchema,
  type InternalMcpCatalogServerType,
  LocalMcpServerInstallationStatusSchema,
  SelectMcpServerSchema,
  UuidIdSchema,
} from "@/types";
import { slugifyName } from "@/utils";

const mcpServerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/mcp_server",
    {
      schema: {
        operationId: RouteId.GetMcpServers,
        description: "Get all installed MCP servers",
        tags: ["MCP Server"],
        response: constructResponseSchema(z.array(SelectMcpServerSchema)),
      },
    },
    async ({ user, headers }, reply) => {
      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServer: ["admin"] },
        headers,
      );
      const allServers = await McpServerModel.findAll(
        user.id,
        isMcpServerAdmin,
      );

      return reply.send(allServers);
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
    async ({ params: { id }, user }, reply) => {
      const server = await McpServerModel.findById(id, user.id);

      if (!server) {
        throw new ApiError(404, "MCP server not found");
      }

      return reply.send(server);
    },
  );

  fastify.post(
    "/api/mcp_server",
    {
      schema: {
        operationId: RouteId.InstallMcpServer,
        description: "Install an MCP server (from catalog or custom)",
        tags: ["MCP Server"],
        body: InsertMcpServerSchema.omit({ serverType: true }).extend({
          agentIds: z.array(UuidIdSchema).optional(),
          secretId: UuidIdSchema.optional(),
          // For PAT tokens (like GitHub), send the token directly
          // and we'll create a secret for it
          accessToken: z.string().optional(),
        }),
        response: constructResponseSchema(SelectMcpServerSchema),
      },
    },
    async ({ body, user }, reply) => {
      let {
        agentIds,
        secretId,
        accessToken,
        userConfigValues,
        environmentValues,
        ...restDataFromRequestBody
      } = body;
      const serverData: typeof restDataFromRequestBody & {
        serverType: InternalMcpCatalogServerType;
      } = {
        ...restDataFromRequestBody,
        serverType: "local",
      };

      // Set owner_id and userId to current user
      serverData.ownerId = user.id;
      serverData.userId = user.id;

      // Track if we created a new secret (for cleanup on failure)
      let createdSecretId: string | undefined;

      // If accessToken is provided (PAT flow), create a secret for it
      if (accessToken && !secretId) {
        const secret = await secretManager.createSecret(
          { access_token: accessToken },
          `${serverData.name}-token`,
        );
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
            await secretManager.deleteSecret(createdSecretId);
          }

          throw new ApiError(
            400,
            "Failed to connect to MCP server with provided credentials",
          );
        }
      }

      // Fetch catalog item to get server type
      let catalogItem = null;
      if (serverData.catalogId) {
        catalogItem = await InternalMcpCatalogModel.findById(
          serverData.catalogId,
        );

        if (!catalogItem) {
          throw new ApiError(400, "Catalog item not found");
        }

        // Set serverType from catalog item
        serverData.serverType = catalogItem.serverType;

        // Validate required environment variables for local servers
        if (
          catalogItem.serverType === "local" &&
          catalogItem.localConfig?.environment
        ) {
          const requiredEnvVars = catalogItem.localConfig.environment.filter(
            (env) => env.promptOnInstallation && env.required,
          );

          const missingEnvVars = requiredEnvVars.filter((env) => {
            const value = environmentValues?.[env.key];
            // For boolean type, check if value exists
            if (env.type === "boolean") {
              return !value;
            }
            // For other types, check if trimmed value is non-empty
            return !value?.trim();
          });

          if (missingEnvVars.length > 0) {
            throw new ApiError(
              400,
              `Missing required environment variables: ${missingEnvVars
                .map((env) => env.key)
                .join(", ")}`,
            );
          }
        }

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
            const secret = await secretManager.createSecret(
              secretEnvVars,
              `mcp-server-${serverData.name}-env`,
            );
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
                // Wait for the pod to be fully ready before fetching tools
                const podManager = McpServerRuntimeManager.getPod(mcpServer.id);
                if (!podManager) {
                  throw new Error("Pod manager not found");
                }

                fastify.log.info(
                  `Waiting for pod to be ready: ${mcpServer.name}`,
                );

                // Wait for pod to be ready (with timeout)
                // This will throw an error if the pod fails or times out
                await podManager.waitForPodReady(60, 2000); // 60 attempts * 2s = 2 minutes max

                fastify.log.info(
                  `Pod is ready, updating status to discovering-tools: ${mcpServer.name}`,
                );

                await McpServerModel.update(mcpServer.id, {
                  localInstallationStatus: "discovering-tools",
                  localInstallationError: null,
                });

                fastify.log.info(
                  `Attempting to fetch tools from local server: ${mcpServer.name}`,
                );
                const tools =
                  await McpServerModel.getToolsFromServer(mcpServer);

                // Persist tools in the database
                // Use catalog item name (without userId) for tool naming to avoid duplicates across users
                const toolNamePrefix = capturedCatalogName || mcpServer.name;
                const toolsToCreate = tools.map((tool) => ({
                  name: slugifyName(toolNamePrefix, tool.name),
                  description: tool.description,
                  parameters: tool.inputSchema,
                  catalogId: capturedCatalogId,
                  mcpServerId: mcpServer.id,
                }));

                // Bulk create tools to avoid N+1 queries
                const createdTools =
                  await ToolModel.bulkCreateToolsIfNotExists(toolsToCreate);

                // If agentIds were provided, create agent-tool assignments with executionSourceMcpServerId
                if (agentIds && agentIds.length > 0) {
                  const toolIds = createdTools.map((t) => t.id);
                  await AgentToolModel.bulkCreateForAgentsAndTools(
                    agentIds,
                    toolIds,
                    {
                      executionSourceMcpServerId: mcpServer.id,
                    },
                  );
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
            // If pod fails to start, set status to error
            const errorMessage =
              podError instanceof Error ? podError.message : "Unknown error";
            fastify.log.error(
              `Failed to start K8s pod for MCP server ${mcpServer.name}: ${errorMessage}`,
            );

            await McpServerModel.update(mcpServer.id, {
              localInstallationStatus: "error",
              localInstallationError: `Failed to start pod: ${errorMessage}`,
            });

            // Return the server with error status instead of throwing 500
            return reply.send({
              ...mcpServer,
              localInstallationStatus: "error",
              localInstallationError: `Failed to start pod: ${errorMessage}`,
            });
          }
        }

        // For non-local servers, fetch tools synchronously during installation
        const tools = await McpServerModel.getToolsFromServer(mcpServer);

        // Catalog item must exist for remote servers
        if (!catalogItem) {
          throw new ApiError(400, "Catalog item not found for remote server");
        }

        // Persist tools in the database with source='mcp_server' and mcpServerId
        // Note: For remote servers, mcpServer.name doesn't include userId, so we can use it directly
        const toolsToCreate = tools.map((tool) => ({
          name: slugifyName(mcpServer.name, tool.name),
          description: tool.description,
          parameters: tool.inputSchema,
          catalogId: catalogItem.id,
          mcpServerId: mcpServer.id,
        }));

        // Bulk create tools to avoid N+1 queries
        const createdTools =
          await ToolModel.bulkCreateToolsIfNotExists(toolsToCreate);

        // If agentIds were provided, create agent-tool assignments
        // Note: Remote servers don't use executionSourceMcpServerId (they route via HTTP)
        if (agentIds && agentIds.length > 0) {
          const toolIds = createdTools.map((t) => t.id);
          await AgentToolModel.bulkCreateForAgentsAndTools(agentIds, toolIds);
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
          await secretManager.deleteSecret(createdSecretId);
        }

        throw new ApiError(
          500,
          `Failed to fetch tools from MCP server ${mcpServer.name}: ${toolError instanceof Error ? toolError.message : "Unknown error"}`,
        );
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
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id: mcpServerId } }, reply) => {
      // Fetch the MCP server first to get secretId and serverType
      const mcpServer = await McpServerModel.findById(mcpServerId);

      if (!mcpServer) {
        throw new ApiError(404, "MCP server not found");
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
          await secretManager.deleteSecret(mcpServer.secretId);
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
    async ({ params: { id } }, reply) => {
      const mcpServer = await McpServerModel.findById(id);

      if (!mcpServer) {
        throw new ApiError(404, "MCP server not found");
      }

      return reply.send({
        localInstallationStatus: mcpServer.localInstallationStatus || "idle",
        localInstallationError: mcpServer.localInstallationError || null,
      });
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
    async ({ params: { id } }, reply) => {
      // Get the MCP server first to check if it has a catalogId
      const mcpServer = await McpServerModel.findById(id);

      if (!mcpServer) {
        throw new ApiError(404, "MCP server not found");
      }

      // For catalog-based servers (local installations), query tools by catalogId
      // This ensures all installations of the same catalog show the same tools
      // For legacy servers without catalogId, fall back to mcpServerId
      const tools = mcpServer.catalogId
        ? await ToolModel.findByCatalogId(mcpServer.catalogId)
        : await ToolModel.findByMcpServerId(id);

      return reply.send(tools);
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
    async ({ params: { id }, query: { lines, follow } }, reply) => {
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
            id,
            reply.raw,
            lines,
          );

          return;
        }

        // Otherwise, return logs as usual
        const logs = await McpServerRuntimeManager.getMcpServerLogs(id, lines);
        return reply.send(logs);
      } catch (error) {
        fastify.log.error(
          `Error getting logs for MCP server ${id}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );

        // If we've already hijacked, we can't send a normal error response
        if (follow && reply.raw.headersSent) {
          reply.raw.end();
          return;
        }

        throw new ApiError(
          404,
          `Failed to get logs for MCP server ${id}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
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
    async ({ params: { id } }, reply) => {
      try {
        await McpServerRuntimeManager.restartServer(id);
        return reply.send({
          success: true,
          message: `MCP server ${id} restarted successfully`,
        });
      } catch (error) {
        fastify.log.error(
          `Failed to restart MCP server ${id}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );

        if (error instanceof Error && error.message?.includes("not found")) {
          throw new ApiError(404, error.message);
        }

        throw new ApiError(
          500,
          `Failed to restart MCP server: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
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
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { catalogId, userId } }, reply) => {
      // Find all servers with this catalogId
      const serversForCatalog = await McpServerModel.findByCatalogId(catalogId);

      // Find the server owned by this user
      const userServer = serversForCatalog.find((s) => s.ownerId === userId);

      if (!userServer) {
        throw new ApiError(
          404,
          "MCP server installation not found for this user",
        );
      }

      // Delete the server (which will cascade delete the secret and mcp_server_user entries)
      await McpServerModel.delete(userServer.id);

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/mcp_server/catalog/:catalogId/teams",
    {
      schema: {
        operationId: RouteId.GrantTeamMcpServerAccess,
        description:
          "Grant team(s) access to an MCP server using specified user's credentials",
        tags: ["MCP Server"],
        params: z.object({
          catalogId: UuidIdSchema,
        }),
        body: z.object({
          teamIds: z.array(z.string()).min(1),
          userId: z.string().optional(), // Optional: specify which user's credentials to use
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (
      { params: { catalogId }, body: { teamIds, userId: targetUserId }, user },
      reply,
    ) => {
      // Use the specified userId or default to current user
      const ownerIdToUse = targetUserId || user.id;

      // Find all servers with this catalogId
      const serversForCatalog = await McpServerModel.findByCatalogId(catalogId);

      // Find the server owned by the specified user
      const targetServer = serversForCatalog.find(
        (s) => s.ownerId === ownerIdToUse,
      );

      if (!targetServer) {
        const errorMsg = targetUserId
          ? `Credentials not found for the specified user.`
          : `You must connect first before granting team access.`;
        throw new ApiError(404, errorMsg);
      }

      // Assign teams to the MCP server
      await McpServerTeamModel.assignTeamsToMcpServer(targetServer.id, teamIds);

      return reply.send({ success: true });
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
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id: mcpServerId, teamId } }, reply) => {
      // Get the MCP server
      const mcpServer = await McpServerModel.findById(mcpServerId);

      if (!mcpServer) {
        throw new ApiError(404, "MCP server not found");
      }

      // When there are multiple installations (personal + team auth), we need to find
      // the actual server that has this team. Check all servers with the same catalogId.
      if (!mcpServer.catalogId) {
        throw new ApiError(404, "MCP server has no catalog ID");
      }

      const allServersForCatalog = await McpServerModel.findByCatalogId(
        mcpServer.catalogId,
      );

      // Find which server actually has this team
      let targetServerId: string | null = null;
      for (const server of allServersForCatalog) {
        const teams = await McpServerTeamModel.getTeamsForMcpServer(server.id);
        if (teams.includes(teamId)) {
          targetServerId = server.id;
          break;
        }
      }

      if (!targetServerId) {
        throw new ApiError(404, "Team access not found");
      }

      // Get the target server to check if we should delete it entirely
      const targetServer = await McpServerModel.findById(targetServerId);
      if (!targetServer) {
        throw new ApiError(404, "Target server not found");
      }

      // If this is a team-only installation (only one team, no users), delete the entire server
      const isTeamOnlyInstallation =
        targetServer.teams?.length === 1 &&
        targetServer.teams[0] === teamId &&
        (!targetServer.users || targetServer.users.length === 0);

      if (isTeamOnlyInstallation) {
        // Delete the entire MCP server (which will cascade delete the secret)
        await McpServerModel.delete(targetServerId);
      } else {
        // Otherwise, just remove the team from the junction table
        await McpServerTeamModel.removeTeamFromMcpServer(
          targetServerId,
          teamId,
        );
      }

      return reply.send({ success: true });
    },
  );

  fastify.delete(
    "/api/mcp_server/catalog/:catalogId/teams",
    {
      schema: {
        operationId: RouteId.RevokeAllTeamsMcpServerAccess,
        description:
          "Revoke all team access from current user's MCP server credentials",
        tags: ["MCP Server"],
        params: z.object({
          catalogId: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { catalogId }, user }, reply) => {
      // Find all servers with this catalogId
      const serversForCatalog = await McpServerModel.findByCatalogId(catalogId);

      // Find the server owned by current user
      const userServer = serversForCatalog.find((s) => s.ownerId === user.id);

      if (!userServer) {
        throw new ApiError(404, "MCP server installation not found");
      }

      // Remove all team assignments from this server
      await McpServerTeamModel.syncMcpServerTeams(userServer.id, []);

      return reply.send({ success: true });
    },
  );
};

export default mcpServerRoutes;
