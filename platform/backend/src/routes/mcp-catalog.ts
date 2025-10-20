import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { McpCatalogModel } from "@/models";
import {
  ErrorResponseSchema,
  InsertMcpCatalogSchema,
  RouteId,
  SelectMcpCatalogSchema,
  UpdateMcpCatalogSchema,
  UuidIdSchema,
} from "@/types";

const mcpCatalogRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/mcp_catalog",
    {
      schema: {
        operationId: RouteId.GetMcpCatalog,
        description: "Get all MCP catalog items",
        tags: ["MCP Catalog"],
        response: {
          200: z.array(SelectMcpCatalogSchema),
          500: ErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      try {
        return reply.send(await McpCatalogModel.findAll());
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
    "/api/mcp_catalog",
    {
      schema: {
        operationId: RouteId.CreateMcpCatalogItem,
        description: "Create a new MCP catalog item",
        tags: ["MCP Catalog"],
        body: InsertMcpCatalogSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: {
          200: SelectMcpCatalogSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await McpCatalogModel.create(request.body));
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
    "/api/mcp_catalog/:id",
    {
      schema: {
        operationId: RouteId.GetMcpCatalogItem,
        description: "Get MCP catalog item by ID",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: SelectMcpCatalogSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const catalogItem = await McpCatalogModel.findById(request.params.id);

        if (!catalogItem) {
          return reply.status(404).send({
            error: {
              message: "Catalog item not found",
              type: "not_found",
            },
          });
        }

        return reply.send(catalogItem);
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

  fastify.put(
    "/api/mcp_catalog/:id",
    {
      schema: {
        operationId: RouteId.UpdateMcpCatalogItem,
        description: "Update an MCP catalog item",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateMcpCatalogSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }).partial(),
        response: {
          200: SelectMcpCatalogSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const catalogItem = await McpCatalogModel.update(
          request.params.id,
          request.body,
        );

        if (!catalogItem) {
          return reply.status(404).send({
            error: {
              message: "Catalog item not found",
              type: "not_found",
            },
          });
        }

        return reply.send(catalogItem);
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
    "/api/mcp_catalog/:id",
    {
      schema: {
        operationId: RouteId.DeleteMcpCatalogItem,
        description: "Delete an MCP catalog item",
        tags: ["MCP Catalog"],
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
          success: await McpCatalogModel.delete(request.params.id),
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

export default mcpCatalogRoutes;
