import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InternalMcpCatalogModel } from "@/models";
import {
  ErrorResponseSchema,
  InsertInternalMcpCatalogSchema,
  RouteId,
  SelectInternalMcpCatalogSchema,
  UpdateInternalMcpCatalogSchema,
  UuidIdSchema,
} from "@/types";

const internalMcpCatalogRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/internal_mcp_catalog",
    {
      schema: {
        operationId: RouteId.GetInternalMcpCatalog,
        description: "Get all Internal MCP catalog items",
        tags: ["MCP Catalog"],
        response: {
          200: z.array(SelectInternalMcpCatalogSchema),
          500: ErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      try {
        return reply.send(await InternalMcpCatalogModel.findAll());
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
    "/api/internal_mcp_catalog",
    {
      schema: {
        operationId: RouteId.CreateInternalMcpCatalogItem,
        description: "Create a new Internal MCP catalog item",
        tags: ["MCP Catalog"],
        body: InsertInternalMcpCatalogSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }),
        response: {
          200: SelectInternalMcpCatalogSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await InternalMcpCatalogModel.create(request.body));
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
    "/api/internal_mcp_catalog/:id",
    {
      schema: {
        operationId: RouteId.GetInternalMcpCatalogItem,
        description: "Get Internal MCP catalog item by ID",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: SelectInternalMcpCatalogSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const catalogItem = await InternalMcpCatalogModel.findById(
          request.params.id,
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

  fastify.put(
    "/api/internal_mcp_catalog/:id",
    {
      schema: {
        operationId: RouteId.UpdateInternalMcpCatalogItem,
        description: "Update an Internal MCP catalog item",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateInternalMcpCatalogSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
        }).partial(),
        response: {
          200: SelectInternalMcpCatalogSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        // Get the original catalog item to check if name or serverUrl changed
        const originalCatalogItem = await InternalMcpCatalogModel.findById(
          request.params.id,
        );

        if (!originalCatalogItem) {
          return reply.status(404).send({
            error: {
              message: "Catalog item not found",
              type: "not_found",
            },
          });
        }

        // Update the catalog item
        const catalogItem = await InternalMcpCatalogModel.update(
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

        // Check if name or serverUrl changed - if so, mark all installed servers for reinstall
        const nameChanged =
          request.body.name && request.body.name !== originalCatalogItem.name;
        const urlChanged =
          request.body.serverUrl &&
          request.body.serverUrl !== originalCatalogItem.serverUrl;

        if (nameChanged || urlChanged) {
          // Import McpServerModel here to avoid circular dependencies
          const { default: McpServerModel } = await import(
            "@/models/mcp-server"
          );

          // Find all servers installed from this catalog item
          const installedServers = await McpServerModel.findByCatalogId(
            request.params.id,
          );

          // Mark each server as needing reinstall
          for (const server of installedServers) {
            await McpServerModel.update(server.id, {
              reinstallRequired: true,
            });
          }
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
    "/api/internal_mcp_catalog/:id",
    {
      schema: {
        operationId: RouteId.DeleteInternalMcpCatalogItem,
        description: "Delete an Internal MCP catalog item",
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
          success: await InternalMcpCatalogModel.delete(request.params.id),
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

export default internalMcpCatalogRoutes;
