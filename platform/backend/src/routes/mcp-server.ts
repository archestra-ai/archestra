import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { McpServerModel } from "@/models";
import {
  ErrorResponseSchema,
  InsertMcpServerSchema,
  RouteId,
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
        response: {
          200: z.array(SelectMcpServerSchema),
          500: ErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      try {
        return reply.send(await McpServerModel.findAll());
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
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const server = await McpServerModel.findById(request.params.id);

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
        }),
        response: {
          200: SelectMcpServerSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await McpServerModel.create(request.body));
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
