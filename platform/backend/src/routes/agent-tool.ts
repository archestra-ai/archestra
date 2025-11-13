import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import {
  AgentModel,
  AgentTeamModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
  UserModel,
} from "@/models";
import {
  AgentToolFilterSchema,
  AgentToolSortBySchema,
  AgentToolSortDirectionSchema,
  constructResponseSchema,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  SelectAgentToolSchema,
  SelectToolSchema,
  UpdateAgentToolSchema,
  UuidIdSchema,
} from "@/types";

const agentToolRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/agent-tools",
    {
      schema: {
        operationId: RouteId.GetAllAgentTools,
        description:
          "Get all agent-tool relationships with pagination, sorting, and filtering",
        tags: ["Agent Tools"],
        querystring: AgentToolFilterSchema.extend({
          sortBy: AgentToolSortBySchema.optional(),
          sortDirection: AgentToolSortDirectionSchema.optional(),
        }).merge(PaginationQuerySchema),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectAgentToolSchema),
        ),
      },
    },
    async (request, reply) => {
      try {
        const { success: isAgentAdmin } = await hasPermission(
          { agent: ["admin"] },
          request.headers,
        );

        const {
          limit,
          offset,
          sortBy,
          sortDirection,
          search,
          agentId,
          origin,
          credentialSourceMcpServerId,
        } = request.query;

        const result = await AgentToolModel.findAllPaginated(
          { limit, offset },
          { sortBy, sortDirection },
          { search, agentId, origin, credentialSourceMcpServerId },
          request.user.id,
          isAgentAdmin,
        );

        return reply.send(result);
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
    "/api/agents/:agentId/tools/:toolId",
    {
      schema: {
        operationId: RouteId.AssignToolToAgent,
        description: "Assign a tool to an agent",
        tags: ["Agent Tools"],
        params: z.object({
          agentId: UuidIdSchema,
          toolId: UuidIdSchema,
        }),
        body: z
          .object({
            credentialSourceMcpServerId: UuidIdSchema.nullable().optional(),
            executionSourceMcpServerId: UuidIdSchema.nullable().optional(),
          })
          .nullish(),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      try {
        const { agentId, toolId } = request.params;
        const { credentialSourceMcpServerId, executionSourceMcpServerId } =
          request.body || {};

        const result = await assignToolToAgent(
          agentId,
          toolId,
          credentialSourceMcpServerId,
          executionSourceMcpServerId,
        );

        if (result && result !== "duplicate") {
          return reply.status(result.status).send(result);
        }

        // Return success for both new assignments and duplicates
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
    "/api/agents/tools/bulk-assign",
    {
      schema: {
        operationId: RouteId.BulkAssignTools,
        description: "Assign multiple tools to multiple agents in bulk",
        tags: ["Agent Tools"],
        body: z.object({
          assignments: z.array(
            z.object({
              agentId: UuidIdSchema,
              toolId: UuidIdSchema,
              credentialSourceMcpServerId: UuidIdSchema.nullable().optional(),
              executionSourceMcpServerId: UuidIdSchema.nullable().optional(),
            }),
          ),
        }),
        response: constructResponseSchema(
          z.object({
            succeeded: z.array(
              z.object({
                agentId: z.string(),
                toolId: z.string(),
              }),
            ),
            failed: z.array(
              z.object({
                agentId: z.string(),
                toolId: z.string(),
                error: z.string(),
              }),
            ),
            duplicates: z.array(
              z.object({
                agentId: z.string(),
                toolId: z.string(),
              }),
            ),
          }),
        ),
      },
    },
    async (request, reply) => {
      try {
        const { assignments } = request.body;

        const results = await Promise.allSettled(
          assignments.map((assignment) =>
            assignToolToAgent(
              assignment.agentId,
              assignment.toolId,
              assignment.credentialSourceMcpServerId,
              assignment.executionSourceMcpServerId,
            ),
          ),
        );

        const succeeded: { agentId: string; toolId: string }[] = [];
        const failed: { agentId: string; toolId: string; error: string }[] = [];
        const duplicates: { agentId: string; toolId: string }[] = [];

        results.forEach((result, index) => {
          const { agentId, toolId } = assignments[index];
          if (result.status === "fulfilled") {
            if (result.value === null) {
              // Success
              succeeded.push({ agentId, toolId });
            } else if (result.value === "duplicate") {
              // Already assigned
              duplicates.push({ agentId, toolId });
            } else {
              // Validation error
              const error = result.value.error.message || "Unknown error";
              failed.push({ agentId, toolId, error });
            }
          } else if (result.status === "rejected") {
            // Runtime error
            const error =
              result.reason instanceof Error
                ? result.reason.message
                : "Unknown error";
            failed.push({ agentId, toolId, error });
          }
        });

        return reply.send({ succeeded, failed, duplicates });
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
    "/api/agents/:agentId/tools/:toolId",
    {
      schema: {
        operationId: RouteId.UnassignToolFromAgent,
        description: "Unassign a tool from an agent",
        tags: ["Agent Tools"],
        params: z.object({
          agentId: UuidIdSchema,
          toolId: UuidIdSchema,
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      try {
        const { agentId, toolId } = request.params;

        const success = await AgentToolModel.delete(agentId, toolId);

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
    "/api/agents/:agentId/tools",
    {
      schema: {
        operationId: RouteId.GetAgentTools,
        description:
          "Get all tools for an agent (both proxy-sniffed and MCP tools)",
        tags: ["Agent Tools"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        response: constructResponseSchema(z.array(SelectToolSchema)),
      },
    },
    async (request, reply) => {
      try {
        const { agentId } = request.params;

        // Validate that agent exists
        const agent = await AgentModel.findById(agentId);
        if (!agent) {
          return reply.status(404).send({
            error: {
              message: `Agent with ID ${agentId} not found`,
              type: "not_found",
            },
          });
        }

        const tools = await ToolModel.getToolsByAgent(agentId);

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

  fastify.patch(
    "/api/agent-tools/:id",
    {
      schema: {
        operationId: RouteId.UpdateAgentTool,
        description: "Update an agent-tool relationship",
        tags: ["Agent Tools"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateAgentToolSchema.pick({
          allowUsageWhenUntrustedDataIsPresent: true,
          toolResultTreatment: true,
          responseModifierTemplate: true,
          credentialSourceMcpServerId: true,
          executionSourceMcpServerId: true,
        }).partial(),
        response: constructResponseSchema(UpdateAgentToolSchema),
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const { credentialSourceMcpServerId, executionSourceMcpServerId } =
          request.body;

        // Get the agent-tool relationship for validation (needed for both credential and execution source)
        let agentToolForValidation:
          | Awaited<ReturnType<typeof AgentToolModel.findAll>>[number]
          | undefined;

        if (credentialSourceMcpServerId || executionSourceMcpServerId) {
          const agentTools = await AgentToolModel.findAll();
          agentToolForValidation = agentTools.find((at) => at.id === id);

          if (!agentToolForValidation) {
            return reply.status(404).send({
              error: {
                message: `Agent-tool relationship with ID ${id} not found`,
                type: "not_found",
              },
            });
          }
        }

        // If credentialSourceMcpServerId is being updated, validate it
        if (credentialSourceMcpServerId && agentToolForValidation) {
          const validationError = await validateCredentialSource(
            agentToolForValidation.agent.id,
            credentialSourceMcpServerId,
          );

          if (validationError) {
            return reply.status(validationError.status).send(validationError);
          }
        }

        // If executionSourceMcpServerId is being updated, validate it
        if (executionSourceMcpServerId && agentToolForValidation) {
          const validationError = await validateExecutionSource(
            agentToolForValidation.tool.id,
            executionSourceMcpServerId,
          );

          if (validationError) {
            return reply.status(validationError.status).send(validationError);
          }
        }

        if (
          executionSourceMcpServerId === null &&
          agentToolForValidation &&
          agentToolForValidation.tool.catalogId
        ) {
          const catalogItem = await InternalMcpCatalogModel.findById(
            agentToolForValidation.tool.catalogId,
          );
          // Check if tool is from local server and executionSourceMcpServerId is being set to null
          if (
            catalogItem?.serverType === "local" &&
            !executionSourceMcpServerId
          ) {
            return reply.status(400).send({
              error: {
                message:
                  "Execution source installation is required for local MCP server tools and cannot be set to null",
                type: "validation_error",
              },
            });
          }
          // Check if tool is from remote server and credentialSourceMcpServerId is being set to null
          if (
            catalogItem?.serverType === "remote" &&
            !credentialSourceMcpServerId
          ) {
            return reply.status(400).send({
              error: {
                message:
                  "Credential source is required for remote MCP server tools and cannot be set to null",
                type: "validation_error",
              },
            });
          }
        }

        const agentTool = await AgentToolModel.update(id, request.body);

        if (!agentTool) {
          return reply.status(404).send({
            error: {
              message: `Agent-tool relationship with ID ${id} not found`,
              type: "not_found",
            },
          });
        }

        return reply.send(agentTool);
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
    "/api/agents/available-tokens",
    {
      schema: {
        operationId: RouteId.GetAgentAvailableTokens,
        description:
          "Get MCP servers that can be used as credential sources for the specified agents' tools",
        tags: ["Agent Tools"],
        querystring: z.object({
          agentIds: z
            .string()
            .transform((val) => val.split(","))
            .pipe(z.array(UuidIdSchema)),
          catalogId: UuidIdSchema.optional(),
        }),
        response: constructResponseSchema(
          z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              authType: z.enum(["personal", "team"]),
              serverType: z.enum(["local", "remote"]),
              catalogId: z.string().nullable(),
              ownerId: z.string().nullable(),
              ownerEmail: z.string().nullable(),
              teamDetails: z
                .array(
                  z.object({
                    teamId: z.string(),
                    name: z.string(),
                    createdAt: z.coerce.date(),
                  }),
                )
                .optional(),
            }),
          ),
        ),
      },
    },
    async (request, reply) => {
      try {
        const { agentIds, catalogId } = request.query;

        // Validate that at least one agent ID is provided
        if (agentIds.length === 0) {
          return reply.status(200).send([]);
        }

        // Validate that all agents exist
        const agents = await Promise.all(
          agentIds.map((id) => AgentModel.findById(id)),
        );
        const invalidAgentIds = agentIds.filter((_id, idx) => !agents[idx]);
        if (invalidAgentIds.length > 0) {
          return reply.status(404).send({
            error: {
              message: `Agent(s) not found: ${invalidAgentIds.join(", ")}`,
              type: "not_found",
            },
          });
        }

        const { success: isAgentAdmin } = await hasPermission(
          { agent: ["admin"] },
          request.headers,
        );

        // Get all MCP servers accessible to the user
        const allServers = await McpServerModel.findAll(
          request.user.id,
          isAgentAdmin,
        );

        // Filter by catalogId if provided
        const filteredServers = catalogId
          ? allServers.filter((server) => server.catalogId === catalogId)
          : allServers;

        // Apply token validation logic to filter available tokens
        // A token is valid if it can be used with ANY of the provided agents
        const validServers = await Promise.all(
          filteredServers.map(async (server) => {
            // Admin personal tokens can be used with any agent
            if (server.authType === "personal" && server.ownerId) {
              const ownerId = server.ownerId;
              // const owner = await UserModel.getById(ownerId);

              /**
               * NOTE: I'm doubtful this will work as intended, right now better-auth's
               * hasPermissions API requires passing in request headers to do the authz check
               * HOWEVER, in this particular context, we are looking at a user which may
               * not necessarily be the user identified by the request.headers...
               */
              const { success: isAgentAdmin } = await hasPermission(
                { agent: ["admin"] },
                request.headers,
              );

              if (isAgentAdmin) {
                return { server, valid: true };
              }

              // Member personal tokens: check if owner belongs to any of the agents' teams
              const hasAccessResults = await Promise.all(
                agentIds.map((agentId) =>
                  /**
                   * NOTE: this is granting too much access here.. we should refactor this,
                   * see the comment above the hasPermission call above for more context..
                   */
                  AgentTeamModel.userHasAgentAccess(ownerId, agentId, true),
                ),
              );
              const hasAccessToAny = hasAccessResults.some(
                (hasAccess) => hasAccess,
              );
              return { server, valid: hasAccessToAny };
            }

            // Team tokens: check if server and any of the agents share a team
            if (server.authType === "team") {
              const shareTeamResults = await Promise.all(
                agentIds.map((agentId) =>
                  AgentTeamModel.agentAndMcpServerShareTeam(agentId, server.id),
                ),
              );
              const shareTeamWithAny = shareTeamResults.some(
                (shareTeam) => shareTeam,
              );
              return { server, valid: shareTeamWithAny };
            }

            return { server, valid: false };
          }),
        );

        const availableTokens = validServers
          .filter(({ valid, server }) => valid && server.authType !== null)
          .map(({ server }) => ({
            id: server.id,
            name: server.name,
            authType: server.authType as "personal" | "team",
            serverType: server.serverType,
            catalogId: server.catalogId,
            ownerId: server.ownerId,
            ownerEmail: server.ownerEmail ?? null,
            teamDetails: server.teamDetails,
          }));

        return reply.send(availableTokens);
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

/**
 * Assigns a single tool to a single agent with validation.
 * Returns null on success, "duplicate" if already exists, or an error object if validation fails.
 */
export async function assignToolToAgent(
  agentId: string,
  toolId: string,
  credentialSourceMcpServerId: string | null | undefined,
  executionSourceMcpServerId: string | null | undefined,
): Promise<
  | {
      status: 400 | 404;
      error: { message: string; type: string };
    }
  | "duplicate"
  | null
> {
  // Validate that agent exists
  const agent = await AgentModel.findById(agentId);
  if (!agent) {
    return {
      status: 404,
      error: {
        message: `Agent with ID ${agentId} not found`,
        type: "not_found",
      },
    };
  }

  // Validate that tool exists
  const tool = await ToolModel.findById(toolId);
  if (!tool) {
    return {
      status: 404,
      error: {
        message: `Tool with ID ${toolId} not found`,
        type: "not_found",
      },
    };
  }

  // Check if tool is from local server (requires executionSourceMcpServerId)
  if (tool.catalogId) {
    const catalogItem = await InternalMcpCatalogModel.findById(tool.catalogId);
    if (catalogItem?.serverType === "local") {
      if (!executionSourceMcpServerId) {
        return {
          status: 400,
          error: {
            message:
              "Execution source installation is required for local MCP server tools",
            type: "validation_error",
          },
        };
      }
    }
    // Check if tool is from remote server (requires credentialSourceMcpServerId)
    if (catalogItem?.serverType === "remote") {
      if (!credentialSourceMcpServerId) {
        return {
          status: 400,
          error: {
            message:
              "Credential source is required for remote MCP server tools",
            type: "validation_error",
          },
        };
      }
    }
  }

  // If a credential source is specified, validate it
  if (credentialSourceMcpServerId) {
    const validationError = await validateCredentialSource(
      agentId,
      credentialSourceMcpServerId,
    );

    if (validationError) {
      return validationError;
    }
  }

  // If an execution source is specified, validate it
  if (executionSourceMcpServerId) {
    const validationError = await validateExecutionSource(
      toolId,
      executionSourceMcpServerId,
    );

    if (validationError) {
      return validationError;
    }
  }

  // Create the assignment (no-op if already exists)
  const result = await AgentToolModel.createIfNotExists(
    agentId,
    toolId,
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
  );

  // If result is null, it means the assignment already existed (duplicate)
  if (result === null) {
    return "duplicate";
  }

  return null;
}

/**
 * Validates that a credentialSourceMcpServerId is valid for the given agent.
 * Returns an error object if validation fails, or null if valid.
 *
 * Validation rules:
 * - (Admin): Admins can use their personal tokens with any agent
 * - Team token: Agent and MCP server must share at least one team
 * - Personal token (Member): Token owner must belong to a team that the agent is assigned to
 */
async function validateCredentialSource(
  agentId: string,
  credentialSourceMcpServerId: string,
): Promise<{
  status: 400 | 404;
  error: { message: string; type: string };
} | null> {
  // Check that the MCP server exists
  const mcpServer = await McpServerModel.findById(credentialSourceMcpServerId);

  if (!mcpServer) {
    return {
      status: 404,
      error: {
        message: `MCP server with ID ${credentialSourceMcpServerId} not found`,
        type: "not_found",
      },
    };
  }

  // Get the token owner's details
  const owner = mcpServer.ownerId
    ? await UserModel.getById(mcpServer.ownerId)
    : null;
  if (!owner) {
    return {
      status: 400,
      error: {
        message: "Personal token owner not found",
        type: "validation_error",
      },
    };
  }

  if (mcpServer.authType === "team") {
    // For team tokens: agent and MCP server must share at least one team
    const shareTeam = await AgentTeamModel.agentAndMcpServerShareTeam(
      agentId,
      credentialSourceMcpServerId,
    );

    if (!shareTeam) {
      return {
        status: 400,
        error: {
          message:
            "The selected team token must belong to a team that this agent is assigned to",
          type: "validation_error",
        },
      };
    }
  } else if (mcpServer.authType === "personal") {
    /**
     * For personal tokens: check if the user is an agent admin or if the owner belongs to a team that the agent
     * is assigned to
     *
     * NOTE: this is granting too much access here.. we should refactor this,
     * see the comment above the hasPermission call above for more context..
     */
    const hasAccess = await AgentTeamModel.userHasAgentAccess(
      owner.id,
      agentId,
      true,
    );

    if (!hasAccess) {
      return {
        status: 400,
        error: {
          message:
            "The selected personal token must belong to a user who is a member of a team that this agent is assigned to",
          type: "validation_error",
        },
      };
    }
  }

  return null;
}

/**
 * Validates that an executionSourceMcpServerId is valid for the given tool.
 * Returns an error object if validation fails, or null if valid.
 *
 * Validation rules:
 * - MCP server must exist
 * - Tool must exist
 * - Execution source must be from the same catalog as the tool (catalog compatibility)
 */
async function validateExecutionSource(
  toolId: string,
  executionSourceMcpServerId: string,
): Promise<{
  status: 400 | 404;
  error: { message: string; type: string };
} | null> {
  // 1. Check MCP server exists
  const mcpServer = await McpServerModel.findById(executionSourceMcpServerId);
  if (!mcpServer) {
    return {
      status: 404,
      error: { message: "MCP server not found", type: "not_found" },
    };
  }

  // 2. Get tool and verify catalog compatibility
  const tool = await ToolModel.findById(toolId);
  if (!tool) {
    return {
      status: 404,
      error: { message: "Tool not found", type: "not_found" },
    };
  }

  if (tool.catalogId !== mcpServer.catalogId) {
    return {
      status: 400,
      error: {
        message: "Execution source must be from the same catalog as the tool",
        type: "validation_error",
      },
    };
  }

  return null;
}

export default agentToolRoutes;
