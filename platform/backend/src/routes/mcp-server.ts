import { isPlaywrightCatalogItem, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import {
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  TeamModel,
  ToolModel,
} from "@/models";
import { isByosEnabled, secretManager } from "@/secrets-manager";
import { autoReinstallServer } from "@/services/mcp-reinstall";
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

const mcpServerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/mcp_server",
    {
      schema: {
        operationId: RouteId.GetMcpServers,
        description: "Get all installed MCP servers",
        tags: ["MCP Server"],
        querystring: z.object({
          catalogId: z.string().optional(),
        }),
        response: constructResponseSchema(z.array(SelectMcpServerSchema)),
      },
    },
    async ({ user, headers, query }, reply) => {
      const { catalogId } = query;
      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServer: ["admin"] },
        headers,
      );
      let allServers = await McpServerModel.findAll(user.id, isMcpServerAdmin);

      // Filter by catalogId if provided
      if (catalogId) {
        allServers = allServers.filter((s) => s.catalogId === catalogId);
      }

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
          // When true, environmentValues and userConfigValues contain vault references in "path#key" format
          isByosVault: z.boolean().optional(),
          // Kubernetes service account override for local MCP servers
          serviceAccount: z.string().optional(),
        }),
        response: constructResponseSchema(SelectMcpServerSchema),
      },
    },
    async ({ body, user, headers }, reply) => {
      let {
        agentIds,
        secretId,
        accessToken,
        isByosVault,
        userConfigValues,
        environmentValues,
        serviceAccount,
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

      // Fetch catalog item FIRST to determine server type
      let catalogItem = null;
      if (serverData.catalogId) {
        catalogItem = await InternalMcpCatalogModel.findById(
          serverData.catalogId,
        );

        if (!catalogItem) {
          throw new ApiError(400, "Catalog item not found");
        }

        // Playwright browser preview can only be installed as a personal server
        if (
          isPlaywrightCatalogItem(serverData.catalogId) &&
          serverData.teamId
        ) {
          throw new ApiError(
            400,
            "Playwright browser preview can only be installed as a personal server",
          );
        }

        // Set serverType from catalog item
        serverData.serverType = catalogItem.serverType;

        // Reject personal installations when Readonly Vault is enabled
        if (isByosEnabled() && !serverData.teamId) {
          throw new ApiError(
            400,
            "Personal MCP server installations are not allowed when Readonly Vault is enabled. Please select a team.",
          );
        }

        // Validate permissions for team installations
        // WHY: We want to restrict who can create team-wide MCP server installations:
        // - Members should NOT be able to create team installations (they lack mcpServer:update)
        // - Editors can create team installations ONLY for teams they are members of
        // - Admins (with team:admin) can create team installations for ANY team
        // This prevents members from installing MCP servers that affect the whole team.
        if (serverData.teamId) {
          const { success: hasTeamAdmin } = await hasPermission(
            { team: ["admin"] },
            headers,
          );

          if (!hasTeamAdmin) {
            // WHY: mcpServer:update distinguishes editors from members
            // Editors have this permission, members don't
            const { success: hasMcpServerUpdate } = await hasPermission(
              { mcpServer: ["update"] },
              headers,
            );

            if (!hasMcpServerUpdate) {
              throw new ApiError(
                403,
                "You don't have permission to create team MCP server installations",
              );
            }

            const isMember = await TeamModel.isUserInTeam(
              serverData.teamId,
              user.id,
            );
            if (!isMember) {
              throw new ApiError(
                403,
                "You can only create MCP server installations for teams you are a member of",
              );
            }
          }
        }

        // Validate no duplicate installations for this catalog item
        const existingServers = await McpServerModel.findByCatalogId(
          serverData.catalogId,
        );

        // Check for duplicate personal installation (same user, no team)
        // Return existing server instead of erroring (idempotent behavior)
        if (!serverData.teamId) {
          const existingPersonal = existingServers.find(
            (s) => s.ownerId === user.id && !s.teamId,
          );
          if (existingPersonal) {
            // If agentIds provided, assign the server's tools to those agents
            if (agentIds && agentIds.length > 0) {
              const catalogTools = await ToolModel.findByCatalogId(
                serverData.catalogId,
              );
              const toolIds = catalogTools.map((t) => t.id);
              if (toolIds.length > 0) {
                for (const agentId of agentIds) {
                  await AgentToolModel.createManyIfNotExists(agentId, toolIds);
                }
              }
            }
            return reply.send(existingPersonal);
          }
        }

        // Check for duplicate team installation (same team)
        if (serverData.teamId) {
          const existingTeam = existingServers.find(
            (s) => s.teamId === serverData.teamId,
          );
          if (existingTeam) {
            throw new ApiError(
              400,
              "This team already has an installation of this MCP server",
            );
          }
        }

        // Update catalog's serviceAccount if user provided a different value
        const normalizedServiceAccount =
          serviceAccount === "" ? undefined : serviceAccount;
        if (
          catalogItem?.serverType === "local" &&
          normalizedServiceAccount !== undefined &&
          catalogItem.localConfig?.serviceAccount !== normalizedServiceAccount
        ) {
          await InternalMcpCatalogModel.update(catalogItem.id, {
            localConfig: {
              ...catalogItem.localConfig,
              serviceAccount: normalizedServiceAccount,
            },
          });
          // Update local reference for deployment
          if (catalogItem.localConfig) {
            catalogItem.localConfig.serviceAccount = normalizedServiceAccount;
          }
        }
      }

      // For REMOTE servers: create secrets and validate connection
      if (catalogItem?.serverType === "remote") {
        // If isByosVault flag is set, use vault references from userConfigValues
        if (isByosVault && userConfigValues && !secretId) {
          if (!isByosEnabled()) {
            throw new ApiError(
              400,
              "Readonly Vault is not enabled. " +
                "Requires ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT and an enterprise license.",
            );
          }

          // userConfigValues already contains vault references in "path#key" format
          const secret = await secretManager().createSecret(
            userConfigValues as Record<string, unknown>,
            `${serverData.name}-vault-secret`,
          );
          secretId = secret.id;
          createdSecretId = secret.id;
          logger.info(
            { keyCount: Object.keys(userConfigValues).length },
            "Created Readonly Vault secret with per-field references for remote server",
          );
        }

        // If accessToken is provided (PAT flow), create a secret for it
        // Not allowed when Readonly Vault is enabled - use vault secrets instead
        if (accessToken && !secretId) {
          if (isByosEnabled()) {
            throw new ApiError(
              400,
              "Manual PAT token input is not allowed when Readonly Vault is enabled. Please use Vault secrets instead.",
            );
          }
          const secret = await secretManager().createSecret(
            { access_token: accessToken },
            `${serverData.name}-token`,
          );
          secretId = secret.id;
          createdSecretId = secret.id;
        }

        // Validate connection for remote servers
        if (secretId) {
          const { isValid, errorMessage } =
            await McpServerModel.validateConnection(
              serverData.name,
              serverData.catalogId ?? undefined,
              secretId,
            );

          if (!isValid) {
            // Clean up the secret we just created if validation fails
            if (createdSecretId) {
              secretManager().deleteSecret(createdSecretId);
            }

            throw new ApiError(
              400,
              errorMessage ||
                "Failed to connect to MCP server with provided credentials",
            );
          }
        }
      }

      // For LOCAL servers: validate env vars and create secrets (no connection validation, since deployment will be started later)
      if (catalogItem?.serverType === "local") {
        // Validate required environment variables
        if (catalogItem.localConfig?.environment) {
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

        // If isByosVault flag is set, use vault references from environmentValues for secret env vars
        if (isByosVault && !secretId && catalogItem.localConfig?.environment) {
          if (!isByosEnabled()) {
            throw new ApiError(
              400,
              "Readonly Vault is not enabled. " +
                "Requires ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT and an enterprise license.",
            );
          }

          // Collect secret env vars with vault references from environmentValues
          const secretEnvVars: Record<string, string> = {};
          for (const envDef of catalogItem.localConfig.environment) {
            if (envDef.type === "secret") {
              const value = envDef.promptOnInstallation
                ? environmentValues?.[envDef.key]
                : envDef.value;
              if (value) {
                // Value should already be in "path#key" format from frontend
                secretEnvVars[envDef.key] = value;
              }
            }
          }

          if (Object.keys(secretEnvVars).length > 0) {
            const secret = await secretManager().createSecret(
              secretEnvVars,
              `${serverData.name}-vault-secret`,
            );
            secretId = secret.id;
            createdSecretId = secret.id;
            logger.info(
              { keyCount: Object.keys(secretEnvVars).length },
              "Created Readonly Vault secret with per-field references for local server",
            );
          }
        }
        // Collect and store secret-type env vars
        // When Readonly Vault is enabled, only static (non-prompted) secrets are allowed to be stored in DB
        // User-prompted secrets must use Vault references via the isByosVault flow above
        else if (!secretId && catalogItem.localConfig?.environment) {
          const secretEnvVars: Record<string, string> = {};
          let hasPromptedSecrets = false;

          // Collect all secret-type env vars (both static and prompted)
          for (const envDef of catalogItem.localConfig.environment) {
            if (envDef.type === "secret") {
              let value: string | undefined;
              // Get value based on whether it's prompted or static
              if (envDef.promptOnInstallation) {
                // Prompted during installation - get from environmentValues
                value = environmentValues?.[envDef.key];
                if (value) {
                  hasPromptedSecrets = true;
                }
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

          // Block user-prompted secrets when Readonly Vault is enabled (they should use Vault)
          // Static secrets from catalog are allowed since they're not manual user input
          if (hasPromptedSecrets && isByosEnabled()) {
            throw new ApiError(
              400,
              "Manual secret input is not allowed when Readonly Vault is enabled. Please use Vault secrets instead.",
            );
          }

          // Create secret in database if there are any secret env vars
          if (Object.keys(secretEnvVars).length > 0) {
            const secret = await secretManager().createSecret(
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

        // For local servers, store accessToken as a secret if provided
        // (e.g., for servers that require JWT auth during tool discovery)
        if (accessToken) {
          if (secretId) {
            // Merge accessToken into existing secret (e.g., when catalog has secret-type env vars)
            const existingSecret = await secretManager().getSecret(secretId);
            if (
              existingSecret?.secret &&
              typeof existingSecret.secret === "object"
            ) {
              await secretManager().updateSecret(secretId, {
                ...(existingSecret.secret as Record<string, string>),
                access_token: accessToken,
              });
            }
          } else {
            const secret = await secretManager().createSecret(
              { access_token: accessToken },
              `${serverData.name}-token`,
            );
            secretId = secret.id;
            createdSecretId = secret.id;
          }
        }
      }

      // Create the MCP server with optional secret reference
      const mcpServer = await McpServerModel.create({
        ...serverData,
        ...(secretId && { secretId }),
      });

      try {
        // For local servers, start the K8s deployment first
        if (catalogItem?.serverType === "local") {
          try {
            // Capture catalogId before async callback to ensure it's available
            const capturedCatalogId = catalogItem.id;
            const capturedCatalogName = catalogItem.name;

            // Set status to pending before starting the deployment
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
              `Started K8s deployment for local MCP server: ${mcpServer.name}`,
            );

            // For local servers, return immediately without waiting for tools
            // Tools will be fetched asynchronously after the deployment is ready
            fastify.log.info(
              `Skipping synchronous tool fetch for local server: ${mcpServer.name}. Tools will be fetched asynchronously.`,
            );

            // Start async tool fetching in the background (non-blocking)
            (async () => {
              try {
                // Wait for the deployment to be fully ready before fetching tools
                const k8sDeployment =
                  await McpServerRuntimeManager.getOrLoadDeployment(
                    mcpServer.id,
                  );
                if (!k8sDeployment) {
                  throw new Error("Deployment manager not found");
                }

                fastify.log.info(
                  `Waiting for deployment to be ready: ${mcpServer.name}`,
                );

                // Wait for deployment to be ready (with timeout)
                await k8sDeployment.waitForDeploymentReady(60, 2000); // 60 attempts * 2s = 2 minutes max

                fastify.log.info(
                  `Deployment is ready, updating status to discovering-tools: ${mcpServer.name}`,
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
                  name: ToolModel.slugifyName(toolNamePrefix, tool.name),
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
            // If deployment fails to start, set status to error
            const errorMessage =
              podError instanceof Error ? podError.message : "Unknown error";
            fastify.log.error(
              `Failed to start K8s deployment for MCP server ${mcpServer.name}: ${errorMessage}`,
            );

            await McpServerModel.update(mcpServer.id, {
              localInstallationStatus: "error",
              localInstallationError: `Failed to start deployment: ${errorMessage}`,
            });

            // Return the server with error status instead of throwing 500
            return reply.send({
              ...mcpServer,
              localInstallationStatus: "error",
              localInstallationError: `Failed to start deployment: ${errorMessage}`,
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
          name: ToolModel.slugifyName(mcpServer.name, tool.name),
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
        // but need credentialSourceMcpServerId to resolve credentials at call time
        if (agentIds && agentIds.length > 0) {
          const toolIds = createdTools.map((t) => t.id);
          await AgentToolModel.bulkCreateForAgentsAndTools(agentIds, toolIds, {
            credentialSourceMcpServerId: mcpServer.id,
          });
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
          await secretManager().deleteSecret(createdSecretId);
        }

        throw new ApiError(
          500,
          `Failed to fetch tools from MCP server ${mcpServer.name}: ${toolError instanceof Error ? toolError.message : "Unknown error"}`,
        );
      }
    },
  );

  /**
   * Re-authenticate an MCP server by updating its secret
   * Used when OAuth token refresh fails and user needs to re-authenticate
   */
  fastify.patch(
    "/api/mcp_server/:id/reauthenticate",
    {
      schema: {
        operationId: RouteId.ReauthenticateMcpServer,
        description:
          "Update MCP server secret after re-authentication (clears OAuth refresh errors)",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          secretId: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectMcpServerSchema),
      },
    },
    async ({ params: { id }, body: { secretId }, user, headers }, reply) => {
      // Get the existing MCP server
      const mcpServer = await McpServerModel.findById(id, user.id);

      if (!mcpServer) {
        throw new ApiError(404, "MCP server not found");
      }

      // Check mcpServer create permission (required for re-authentication)
      const { success: hasMcpServerCreatePermission } = await hasPermission(
        { mcpServer: ["create"] },
        headers,
      );

      if (!hasMcpServerCreatePermission) {
        throw new ApiError(
          403,
          "You need MCP server create permission to re-authenticate",
        );
      }

      // For personal credentials, only owner can re-authenticate
      if (!mcpServer.teamId) {
        if (mcpServer.ownerId !== user.id) {
          throw new ApiError(
            403,
            "Only the credential owner can re-authenticate",
          );
        }
      } else {
        // For team credentials: user must have team:admin OR (mcpServer:update AND team membership)
        // WHY: This matches the team installation permission requirements - only editors and admins
        // can manage team credentials, members cannot.
        // Same rules apply for re-authentication.
        const { success: isTeamAdmin } = await hasPermission(
          { team: ["admin"] },
          headers,
        );

        if (!isTeamAdmin) {
          // WHY: mcpServer:update distinguishes editors from members
          // Editors have this permission, members don't
          const { success: hasMcpServerUpdate } = await hasPermission(
            { mcpServer: ["update"] },
            headers,
          );

          if (!hasMcpServerUpdate) {
            throw new ApiError(
              403,
              "You don't have permission to re-authenticate team credentials",
            );
          }

          // WHY: Even editors can only re-authenticate for their own teams
          const isMember = await TeamModel.isUserInTeam(
            mcpServer.teamId,
            user.id,
          );
          if (!isMember) {
            throw new ApiError(
              403,
              "You can only re-authenticate credentials for teams you are a member of",
            );
          }
        }
      }

      // Delete the old secret if it exists
      if (mcpServer.secretId) {
        try {
          await secretManager().deleteSecret(mcpServer.secretId);
          logger.info(
            { mcpServerId: id, oldSecretId: mcpServer.secretId },
            "Deleted old secret during re-authentication",
          );
        } catch (error) {
          logger.error(
            { err: error, mcpServerId: id },
            "Failed to delete old secret during re-authentication",
          );
          // Continue with update even if old secret deletion fails
        }
      }

      // Update the server with new secret and clear OAuth error fields
      const updatedServer = await McpServerModel.update(id, {
        secretId,
        oauthRefreshError: null,
        oauthRefreshFailedAt: null,
      });

      if (!updatedServer) {
        throw new ApiError(500, "Failed to update MCP server");
      }

      logger.info(
        { mcpServerId: id, newSecretId: secretId },
        "MCP server re-authenticated successfully",
      );

      return reply.send(updatedServer);
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

      // Prevent deletion of built-in MCP servers
      if (mcpServer.serverType === "builtin") {
        throw new ApiError(400, "Cannot delete built-in MCP servers");
      }

      // For local servers, stop the server (this will delete the K8s Secret)
      if (mcpServer.serverType === "local") {
        try {
          await McpServerRuntimeManager.stopServer(mcpServerId);
          logger.info(
            { mcpServerId },
            "Stopped K8s deployment and deleted K8s Secret for local MCP server",
          );
        } catch (error) {
          logger.error(
            { err: error, mcpServerId },
            "Failed to stop local MCP server deployment",
          );
          // Continue with deletion even if pod stop fails
        }
      }

      // Delete database secret if it exists and is for a local server
      // (don't delete OAuth tokens for remote servers)
      if (mcpServer.secretId && mcpServer.serverType === "local") {
        try {
          await secretManager().deleteSecret(mcpServer.secretId);
          logger.info(
            { mcpServerId },
            "Deleted database secret for local MCP server",
          );
        } catch (error) {
          logger.error(
            { err: error, mcpServerId },
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

  /**
   * Reinstall an MCP server without losing tool assignments and policies.
   *
   * Unlike delete + install, this endpoint:
   * 1. Keeps the MCP server record (and its ID)
   * 2. Updates secrets if new environment values are provided
   * 3. Restarts the K8s deployment (for local servers)
   * 4. Syncs tools (updates existing, creates new) instead of deleting
   * 5. Preserves tool_invocation_policies, trusted_data_policies, and agent_tools
   */
  fastify.post(
    "/api/mcp_server/:id/reinstall",
    {
      schema: {
        operationId: RouteId.ReinstallMcpServer,
        description:
          "Reinstall an MCP server without losing tool assignments and policies",
        tags: ["MCP Server"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          // Environment values for local servers (when new prompted env vars were added)
          environmentValues: z.record(z.string(), z.string()).optional(),
          // Whether environmentValues contains vault references in path#key format
          isByosVault: z.boolean().optional(),
          // Kubernetes service account override
          serviceAccount: z.string().optional(),
        }),
        response: constructResponseSchema(SelectMcpServerSchema),
      },
    },
    async ({ params: { id }, body, user, headers }, reply) => {
      const { environmentValues, isByosVault, serviceAccount } = body;

      // Get the existing MCP server
      const mcpServer = await McpServerModel.findById(id, user.id);

      if (!mcpServer) {
        throw new ApiError(404, "MCP server not found");
      }

      // Check permissions for reinstall (same logic as re-authenticate)
      // For personal servers, only owner can reinstall
      if (!mcpServer.teamId) {
        if (mcpServer.ownerId !== user.id) {
          throw new ApiError(
            403,
            "Only the server owner can reinstall this MCP server",
          );
        }
      } else {
        // For team servers: user must have team:admin OR (mcpServer:update AND team membership)
        // WHY: This matches the team installation permission requirements - only editors and admins
        // can manage team servers, members cannot.
        const { success: isTeamAdmin } = await hasPermission(
          { team: ["admin"] },
          headers,
        );

        if (!isTeamAdmin) {
          // WHY: mcpServer:update distinguishes editors from members
          // Editors have this permission, members don't
          const { success: hasMcpServerUpdate } = await hasPermission(
            { mcpServer: ["update"] },
            headers,
          );

          if (!hasMcpServerUpdate) {
            throw new ApiError(
              403,
              "You don't have permission to reinstall team MCP servers",
            );
          }

          // WHY: Even editors can only reinstall servers for their own teams
          const isMember = await TeamModel.isUserInTeam(
            mcpServer.teamId,
            user.id,
          );
          if (!isMember) {
            throw new ApiError(
              403,
              "You can only reinstall MCP servers for teams you are a member of",
            );
          }
        }
      }

      // Get catalog item
      const catalogItem = mcpServer.catalogId
        ? await InternalMcpCatalogModel.findById(mcpServer.catalogId)
        : null;

      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found for this server");
      }

      // For local servers with new environment values: update/create the secret
      if (
        mcpServer.serverType === "local" &&
        environmentValues &&
        Object.keys(environmentValues).length > 0
      ) {
        // Validate required environment variables
        if (catalogItem.localConfig?.environment) {
          const requiredEnvVars = catalogItem.localConfig.environment.filter(
            (env) => env.promptOnInstallation && env.required,
          );

          const missingEnvVars = requiredEnvVars.filter((env) => {
            const value = environmentValues[env.key];
            if (env.type === "boolean") {
              return !value;
            }
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

        // Update or create secret with new values
        if (isByosVault) {
          // BYOS mode: values are vault references
          if (!isByosEnabled()) {
            throw new ApiError(
              400,
              "Readonly Vault is not enabled. " +
                "Requires ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT and an enterprise license.",
            );
          }

          if (mcpServer.secretId) {
            await secretManager().updateSecret(
              mcpServer.secretId,
              environmentValues,
            );
          } else {
            const secret = await secretManager().createSecret(
              environmentValues,
              `${mcpServer.name}-vault-secret`,
            );
            await McpServerModel.update(id, { secretId: secret.id });
          }
        } else {
          // Non-BYOS mode: merge new values with existing secret
          const existingSecrets = mcpServer.secretId
            ? (await secretManager().getSecret(mcpServer.secretId))?.secret ||
              {}
            : {};

          const mergedSecrets = {
            ...existingSecrets,
            ...environmentValues,
          };

          if (mcpServer.secretId) {
            await secretManager().updateSecret(
              mcpServer.secretId,
              mergedSecrets,
            );
          } else {
            const secret = await secretManager().createSecret(
              mergedSecrets,
              `mcp-server-${mcpServer.name}-env`,
            );
            await McpServerModel.update(id, { secretId: secret.id });
          }
        }

        logger.info(
          { serverId: id, envVarCount: Object.keys(environmentValues).length },
          "Updated MCP server secrets for reinstall",
        );
      }

      // Update service account if provided
      if (
        serviceAccount !== undefined &&
        catalogItem.localConfig?.serviceAccount !== serviceAccount
      ) {
        await InternalMcpCatalogModel.update(catalogItem.id, {
          localConfig: {
            ...catalogItem.localConfig,
            serviceAccount: serviceAccount || undefined,
          },
        });
      }

      // Set status to "pending" immediately so UI shows progress bar
      await McpServerModel.update(id, {
        localInstallationStatus: "pending",
        localInstallationError: null,
      });

      // Refetch the server with updated status
      const updatedServer = await McpServerModel.findById(id);
      if (!updatedServer) {
        throw new ApiError(500, "Server not found after update");
      }

      // Perform the reinstall asynchronously (don't block the response)
      // Use setImmediate to fully detach from the request lifecycle
      // This allows the frontend to show the progress bar immediately
      setImmediate(async () => {
        try {
          await autoReinstallServer(updatedServer, catalogItem);
          // Set status to success when done
          await McpServerModel.update(id, {
            localInstallationStatus: "success",
          });
          logger.info(
            { serverId: id, serverName: mcpServer.name },
            "MCP server reinstalled successfully",
          );
        } catch (error) {
          // Set status to error if reinstall fails
          await McpServerModel.update(id, {
            localInstallationStatus: "error",
            localInstallationError:
              error instanceof Error ? error.message : "Unknown error",
          });
          logger.error(
            { err: error, serverId: id },
            "Failed to reinstall MCP server",
          );
        }
      });

      // Return the server immediately with "pending" status
      return reply.send(updatedServer);
    },
  );
};

export default mcpServerRoutes;
