import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentToolModel, McpServerModel, ToolModel } from "@/models";
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
        }),
        response: {
          200: SelectMcpServerSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { agentIds, ...serverData } = request.body;

        // Validate metadata if provided (for servers that require authentication)
        if (
          serverData.metadata &&
          Object.keys(serverData.metadata).length > 0
        ) {
          const isValid = await McpServerModel.validateConnection(
            serverData.name,
            serverData.metadata,
          );

          if (!isValid) {
            return reply.status(400).send({
              error: {
                message:
                  "Failed to connect to MCP server with provided credentials",
                type: "validation_error",
              },
            });
          }
        }

        // Create the MCP server
        const mcpServer = await McpServerModel.create(serverData);

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
};

export default mcpServerRoutes;
