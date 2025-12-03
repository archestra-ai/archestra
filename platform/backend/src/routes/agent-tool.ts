import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { groupBy } from "lodash-es";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import {
  AgentModel,
  AgentTeamModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
  UserModel,
} from "@/models";
import type { InternalMcpCatalog, Tool } from "@/types";
import {
  AgentToolFilterSchema,
  AgentToolSortBySchema,
  AgentToolSortDirectionSchema,
  ApiError,
  BulkUpdateAgentToolsRequestSchema,
  BulkUpdateAgentToolsResponseSchema,
  constructResponseSchema,
  createPaginatedResponseSchema,
  DeleteObjectResponseSchema,
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
    async (
      {
        query: {
          limit,
          offset,
          sortBy,
          sortDirection,
          search,
          agentId,
          origin,
          mcpServerOwnerId,
          excludeArchestraTools,
        },
        headers,
        user,
      },
      reply,
    ) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const result = await AgentToolModel.findAllPaginated(
        { limit, offset },
        { sortBy, sortDirection },
        {
          search,
          agentId,
          origin,
          mcpServerOwnerId,
          excludeArchestraTools,
        },
        user.id,
        isAgentAdmin,
      );

      return reply.send(result);
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
      const { agentId, toolId } = request.params;
      const { credentialSourceMcpServerId, executionSourceMcpServerId } =
        request.body || {};

      const result = await assignToolToAgent(
        agentId,
        toolId,
        credentialSourceMcpServerId,
        executionSourceMcpServerId,
      );

      if (result && result !== "duplicate" && result !== "updated") {
        throw new ApiError(result.status, result.error.message);
      }

      // Clear chat MCP client cache to ensure fresh tools are fetched
      clearChatMcpClient(agentId);

      // Return success for new assignments, duplicates, and updates
      return reply.send({ success: true });
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
      const { assignments } = request.body;

      // Extract unique IDs for batch fetching to avoid N+1 queries
      const uniqueAgentIds = [...new Set(assignments.map((a) => a.agentId))];
      const uniqueToolIds = [...new Set(assignments.map((a) => a.toolId))];

      // Batch fetch all required data in parallel
      const [existingAgentIds, tools] = await Promise.all([
        AgentModel.existsBatch(uniqueAgentIds),
        ToolModel.getByIds(uniqueToolIds),
      ]);

      // Create maps for efficient lookup
      const toolsMap = new Map(tools.map((tool) => [tool.id, tool]));

      // Extract unique catalog IDs from tools that have them
      const uniqueCatalogIds = [
        ...new Set(
          tools.filter((t) => t.catalogId).map((t) => t.catalogId as string),
        ),
      ];

      // Batch fetch catalog items if needed
      const catalogItemsMap =
        uniqueCatalogIds.length > 0
          ? await InternalMcpCatalogModel.getByIds(uniqueCatalogIds)
          : new Map<string, InternalMcpCatalog>();

      // Prepare pre-fetched data to pass to assignToolToAgent
      const preFetchedData = {
        existingAgentIds,
        toolsMap,
        catalogItemsMap,
      };

      const results = await Promise.allSettled(
        assignments.map((assignment) =>
          assignToolToAgent(
            assignment.agentId,
            assignment.toolId,
            assignment.credentialSourceMcpServerId,
            assignment.executionSourceMcpServerId,
            preFetchedData,
          ),
        ),
      );

      const succeeded: { agentId: string; toolId: string }[] = [];
      const failed: { agentId: string; toolId: string; error: string }[] = [];
      const duplicates: { agentId: string; toolId: string }[] = [];

      results.forEach((result, index) => {
        const { agentId, toolId } = assignments[index];
        if (result.status === "fulfilled") {
          if (result.value === null || result.value === "updated") {
            // Success (created or updated credentials)
            succeeded.push({ agentId, toolId });
          } else if (result.value === "duplicate") {
            // Already assigned with same credentials
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

      // Clear chat MCP client cache for all affected agents
      const affectedAgentIds = new Set([
        ...succeeded.map((s) => s.agentId),
        ...duplicates.map((d) => d.agentId),
      ]);
      for (const agentId of affectedAgentIds) {
        clearChatMcpClient(agentId);
      }

      return reply.send({ succeeded, failed, duplicates });
    },
  );

  fastify.post(
    "/api/agent-tools/bulk-update",
    {
      schema: {
        operationId: RouteId.BulkUpdateAgentTools,
        description: "Update multiple agent tools with the same value in bulk",
        tags: ["Agent Tools"],
        body: BulkUpdateAgentToolsRequestSchema,
        response: constructResponseSchema(BulkUpdateAgentToolsResponseSchema),
      },
    },
    async (request, reply) => {
      const { ids, field, value } = request.body;

      const updatedCount = await AgentToolModel.bulkUpdateSameValue(
        ids,
        field,
        value as boolean | "trusted" | "sanitize_with_dual_llm" | "untrusted",
      );

      return reply.send({ updatedCount });
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
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { agentId, toolId } }, reply) => {
      const success = await AgentToolModel.delete(agentId, toolId);

      if (!success) {
        throw new ApiError(404, "Agent tool not found");
      }

      // Clear chat MCP client cache to ensure fresh tools are fetched
      clearChatMcpClient(agentId);

      return reply.send({ success });
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
    async ({ params: { agentId } }, reply) => {
      // Validate that agent exists
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        throw new ApiError(404, `Agent with ID ${agentId} not found`);
      }

      const tools = await ToolModel.getToolsByAgent(agentId);

      return reply.send(tools);
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
    async ({ params: { id }, body }, reply) => {
      const { credentialSourceMcpServerId, executionSourceMcpServerId } = body;

      // Get the agent-tool relationship for validation (needed for both credential and execution source)
      let agentToolForValidation:
        | Awaited<ReturnType<typeof AgentToolModel.findAll>>[number]
        | undefined;

      if (credentialSourceMcpServerId || executionSourceMcpServerId) {
        const agentTools = await AgentToolModel.findAll();
        agentToolForValidation = agentTools.find((at) => at.id === id);

        if (!agentToolForValidation) {
          throw new ApiError(
            404,
            `Agent-tool relationship with ID ${id} not found`,
          );
        }
      }

      // If credentialSourceMcpServerId is being updated, validate it
      if (credentialSourceMcpServerId && agentToolForValidation) {
        const validationError = await validateCredentialSource(
          agentToolForValidation.agent.id,
          credentialSourceMcpServerId,
        );

        if (validationError) {
          throw new ApiError(
            validationError.status,
            validationError.error.message,
          );
        }
      }

      // If executionSourceMcpServerId is being updated, validate it
      if (executionSourceMcpServerId && agentToolForValidation) {
        const validationError = await validateExecutionSource(
          agentToolForValidation.tool.id,
          executionSourceMcpServerId,
        );

        if (validationError) {
          throw new ApiError(
            validationError.status,
            validationError.error.message,
          );
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
          throw new ApiError(
            400,
            "Execution source installation is required for local MCP server tools and cannot be set to null",
          );
        }
        // Check if tool is from remote server and credentialSourceMcpServerId is being set to null
        if (
          catalogItem?.serverType === "remote" &&
          !credentialSourceMcpServerId
        ) {
          throw new ApiError(
            400,
            "Credential source is required for remote MCP server tools and cannot be set to null",
          );
        }
      }

      const agentTool = await AgentToolModel.update(id, body);

      if (!agentTool) {
        throw new ApiError(
          404,
          `Agent-tool relationship with ID ${id} not found`,
        );
      }

      // Clear chat MCP client cache to ensure fresh tools are fetched
      clearChatMcpClient(agentTool.agentId);

      return reply.send(agentTool);
    },
  );

  fastify.get(
    "/api/agents/available-tokens",
    {
      schema: {
        operationId: RouteId.GetAgentAvailableTokens,
        description:
          "Get MCP servers that can be used as credential sources for the specified agents' tools, grouped by catalogId",
        tags: ["Agent Tools"],
        querystring: z.object({
          catalogId: UuidIdSchema.optional(),
        }),
        response: constructResponseSchema(
          z.record(
            z.string(),
            z.array(
              z.object({
                id: z.string(),
                name: z.string(),
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
        ),
      },
    },
    async ({ query: { catalogId }, headers, user }, reply) => {
      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      // Get all MCP servers accessible to the user
      const allServers = await McpServerModel.findAll(user.id, isAgentAdmin);

      // Filter by catalogId if provided, otherwise include all
      const filteredServers = catalogId
        ? allServers.filter((server) => server.catalogId === catalogId)
        : allServers;

      // Map servers to the response format
      const mappedServers = filteredServers.map((server) => ({
        id: server.id,
        name: server.name,
        serverType: server.serverType as "local" | "remote",
        catalogId: server.catalogId,
        ownerId: server.ownerId,
        ownerEmail: server.ownerEmail ?? null,
        teamDetails: server.teamDetails,
      }));

      // Sort servers: current user's credentials first, then others
      const currentUserId = user.id;
      const sortedServers = mappedServers.sort((a, b) => {
        const aIsCurrentUser = a.ownerId === currentUserId;
        const bIsCurrentUser = b.ownerId === currentUserId;

        // Current user's credentials come first
        if (aIsCurrentUser && !bIsCurrentUser) return -1;
        if (!aIsCurrentUser && bIsCurrentUser) return 1;

        // Keep original order otherwise
        return 0;
      });

      // Group by catalogId
      const groupedByCatalogId = groupBy(
        sortedServers,
        (server) => server.catalogId,
      );

      return reply.send(groupedByCatalogId);
    },
  );
};

/**
 * Assigns a single tool to a single agent with validation.
 * Returns null on success/update, "duplicate" if already exists with same credentials, or an error object if validation fails.
 *
 * @param preFetchedData - Optional pre-fetched data to avoid N+1 queries in bulk operations
 */
export async function assignToolToAgent(
  agentId: string,
  toolId: string,
  credentialSourceMcpServerId: string | null | undefined,
  executionSourceMcpServerId: string | null | undefined,
  preFetchedData?: {
    existingAgentIds?: Set<string>;
    toolsMap?: Map<string, Tool>;
    catalogItemsMap?: Map<string, InternalMcpCatalog>;
  },
): Promise<
  | {
      status: 400 | 404;
      error: { message: string; type: string };
    }
  | "duplicate"
  | "updated"
  | null
> {
  // Validate that agent exists (using pre-fetched data or lightweight exists() to avoid N+1 queries)
  let agentExists: boolean;
  if (preFetchedData?.existingAgentIds) {
    agentExists = preFetchedData.existingAgentIds.has(agentId);
  } else {
    agentExists = await AgentModel.exists(agentId);
  }

  if (!agentExists) {
    return {
      status: 404,
      error: {
        message: `Agent with ID ${agentId} not found`,
        type: "not_found",
      },
    };
  }

  // Validate that tool exists (using pre-fetched data to avoid N+1 queries)
  let tool: Tool | null;
  if (preFetchedData?.toolsMap) {
    tool = preFetchedData.toolsMap.get(toolId) || null;
  } else {
    tool = await ToolModel.findById(toolId);
  }

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
    let catalogItem: InternalMcpCatalog | null;
    if (preFetchedData?.catalogItemsMap) {
      catalogItem = preFetchedData.catalogItemsMap.get(tool.catalogId) || null;
    } else {
      catalogItem = await InternalMcpCatalogModel.findById(tool.catalogId);
    }

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

  // Create or update the assignment with credentials
  const result = await AgentToolModel.createOrUpdateCredentials(
    agentId,
    toolId,
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
  );

  // Return appropriate status
  if (result.status === "unchanged") {
    return "duplicate";
  }

  if (result.status === "updated") {
    return "updated";
  }

  return null; // created
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

  // Check if the owner has access to the agent (either directly or through teams)
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
          "The credential owner must be a member of a team that this profile is assigned to",
        type: "validation_error",
      },
    };
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
