import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
  UserModel,
} from "@/models";
import { agentToolAutoPolicyService } from "@/models/agent-tool-auto-policy";
import type { InternalMcpCatalog, Tool } from "@/types";
import {
  AgentToolFilterSchema,
  AgentToolSortBySchema,
  AgentToolSortDirectionSchema,
  ApiError,
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
          skipPagination: z.coerce.boolean().optional(),
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
          skipPagination,
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

      const result = await AgentToolModel.findAll({
        pagination: { limit, offset },
        sorting: { sortBy, sortDirection },
        filters: {
          search,
          agentId,
          origin,
          mcpServerOwnerId,
          excludeArchestraTools,
        },
        userId: user.id,
        isAgentAdmin,
        skipPagination,
      });

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
            useDynamicTeamCredential: z.boolean().optional(),
          })
          .nullish(),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (request, reply) => {
      const { agentId, toolId } = request.params;
      const {
        credentialSourceMcpServerId,
        executionSourceMcpServerId,
        useDynamicTeamCredential,
      } = request.body || {};

      const result = await assignToolToAgent(
        agentId,
        toolId,
        credentialSourceMcpServerId,
        executionSourceMcpServerId,
        undefined,
        useDynamicTeamCredential,
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
              useDynamicTeamCredential: z.boolean().optional(),
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
            assignment.useDynamicTeamCredential,
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
    "/api/agent-tools/auto-configure-policies",
    {
      schema: {
        operationId: RouteId.AutoConfigureAgentToolPolicies,
        description:
          "Automatically configure security policies for agent-tool assignments using Anthropic LLM analysis",
        tags: ["Agent Tools"],
        body: z.object({
          agentToolIds: z.array(z.string().uuid()).min(1),
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            results: z.array(
              z.object({
                agentToolId: z.string().uuid(),
                success: z.boolean(),
                config: z
                  .object({
                    toolResultTreatment: z.enum([
                      "trusted",
                      "sanitize_with_dual_llm",
                      "untrusted",
                    ]),
                    reasoning: z.string(),
                  })
                  .optional(),
                error: z.string().optional(),
              }),
            ),
          }),
        ),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const { agentToolIds } = body;

      logger.info(
        { organizationId, userId: user.id, count: agentToolIds.length },
        "POST /api/agent-tools/auto-configure-policies: request received",
      );

      // Check if service is available for this organization
      const available =
        await agentToolAutoPolicyService.isAvailable(organizationId);
      if (!available) {
        logger.warn(
          { organizationId, userId: user.id },
          "POST /api/agent-tools/auto-configure-policies: service not available",
        );
        throw new ApiError(
          503,
          "Auto-policy requires a default Anthropic chat API key to be configured",
        );
      }

      const result =
        await agentToolAutoPolicyService.configurePoliciesForAgentTools(
          agentToolIds,
          organizationId,
        );

      logger.info(
        {
          organizationId,
          userId: user.id,
          success: result.success,
          resultsCount: result.results.length,
        },
        "POST /api/agent-tools/auto-configure-policies: completed",
      );

      return reply.send(result);
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
        querystring: z.object({
          excludeLlmProxyOrigin: z.coerce.boolean().optional().default(false),
        }),
        response: constructResponseSchema(z.array(SelectToolSchema)),
      },
    },
    async ({ params: { agentId }, query }, reply) => {
      // Validate that agent exists
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        throw new ApiError(404, `Agent with ID ${agentId} not found`);
      }

      const tools = query.excludeLlmProxyOrigin
        ? await ToolModel.getMcpToolsByAgent(agentId)
        : await ToolModel.getToolsByAgent(agentId);

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
          responseModifierTemplate: true,
          credentialSourceMcpServerId: true,
          executionSourceMcpServerId: true,
          useDynamicTeamCredential: true,
          policiesAutoConfiguredAt: true,
        }).partial(),
        response: constructResponseSchema(UpdateAgentToolSchema),
      },
    },
    async ({ params: { id }, body }, reply) => {
      const {
        credentialSourceMcpServerId,
        executionSourceMcpServerId,
        useDynamicTeamCredential,
      } = body;

      // Get the agent-tool relationship for validation (needed for both credential and execution source)
      let agentToolForValidation:
        | Awaited<ReturnType<typeof AgentToolModel.findAll>>["data"][number]
        | undefined;

      if (credentialSourceMcpServerId || executionSourceMcpServerId) {
        const agentTools = await AgentToolModel.findAll({
          skipPagination: true,
        });
        agentToolForValidation = agentTools.data.find((at) => at.id === id);

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
        // Only need serverType for validation, no secrets needed
        const catalogItem = await InternalMcpCatalogModel.findById(
          agentToolForValidation.tool.catalogId,
          { expandSecrets: false },
        );
        // Check if tool is from local server and executionSourceMcpServerId is being set to null
        // (allowed if useDynamicTeamCredential is being set to true)
        if (
          catalogItem?.serverType === "local" &&
          !executionSourceMcpServerId &&
          !useDynamicTeamCredential
        ) {
          throw new ApiError(
            400,
            "Execution source installation or dynamic team credential is required for local MCP server tools",
          );
        }
        // Check if tool is from remote server and credentialSourceMcpServerId is being set to null
        // (allowed if useDynamicTeamCredential is being set to true)
        if (
          catalogItem?.serverType === "remote" &&
          !credentialSourceMcpServerId &&
          !useDynamicTeamCredential
        ) {
          throw new ApiError(
            400,
            "Credential source or dynamic team credential is required for remote MCP server tools",
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
  useDynamicTeamCredential?: boolean,
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
      // Only need serverType for validation, no secrets needed
      catalogItem = await InternalMcpCatalogModel.findById(tool.catalogId, {
        expandSecrets: false,
      });
    }

    if (catalogItem?.serverType === "local") {
      if (!executionSourceMcpServerId && !useDynamicTeamCredential) {
        return {
          status: 400,
          error: {
            message:
              "Execution source installation or dynamic team credential is required for local MCP server tools",
            type: "validation_error",
          },
        };
      }
    }
    // Check if tool is from remote server (requires credentialSourceMcpServerId OR useDynamicTeamCredential)
    if (catalogItem?.serverType === "remote") {
      if (!credentialSourceMcpServerId && !useDynamicTeamCredential) {
        return {
          status: 400,
          error: {
            message:
              "Credential source or dynamic team credential is required for remote MCP server tools",
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
    useDynamicTeamCredential,
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
