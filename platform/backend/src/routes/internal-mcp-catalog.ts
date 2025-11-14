import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InternalMcpCatalogModel, McpServerModel, ToolModel } from "@/models";
import {
  constructResponseSchema,
  InsertInternalMcpCatalogSchema,
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
        response: constructResponseSchema(
          z.array(SelectInternalMcpCatalogSchema),
        ),
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
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
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
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
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
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
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

        // Mark all installed servers for reinstall
        // and delete existing tools so they can be rediscovered
        const installedServers = await McpServerModel.findByCatalogId(
          request.params.id,
        );

        for (const server of installedServers) {
          await McpServerModel.update(server.id, {
            reinstallRequired: true,
          });
        }

        // Delete all tools associated with this catalog id
        // This ensures tools are rediscovered with updated configuration during reinstall
        await ToolModel.deleteByCatalogId(request.params.id);

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
        response: constructResponseSchema(z.object({ success: z.boolean() })),
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
