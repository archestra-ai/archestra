import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InternalMcpCatalogModel, McpServerModel, ToolModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
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
      return reply.send(await InternalMcpCatalogModel.findAll());
    },
  );

  fastify.post(
    "/api/internal_mcp_catalog",
    {
      schema: {
        operationId: RouteId.CreateInternalMcpCatalogItem,
        description: "Create a new Internal MCP catalog item",
        tags: ["MCP Catalog"],
        body: InsertInternalMcpCatalogSchema,
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
      },
    },
    async ({ body }, reply) => {
      return reply.send(await InternalMcpCatalogModel.create(body));
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
    async ({ params: { id } }, reply) => {
      const catalogItem = await InternalMcpCatalogModel.findById(id);

      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      return reply.send(catalogItem);
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
        body: UpdateInternalMcpCatalogSchema.partial(),
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
      },
    },
    async ({ params: { id }, body }, reply) => {
      // Get the original catalog item to check if name or serverUrl changed
      const originalCatalogItem = await InternalMcpCatalogModel.findById(id);

      if (!originalCatalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      // Update the catalog item
      const catalogItem = await InternalMcpCatalogModel.update(id, body);

      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      // Mark all installed servers for reinstall
      // and delete existing tools so they can be rediscovered
      const installedServers = await McpServerModel.findByCatalogId(id);

      for (const server of installedServers) {
        await McpServerModel.update(server.id, {
          reinstallRequired: true,
        });
      }

      // Delete all tools associated with this catalog id
      // This ensures tools are rediscovered with updated configuration during reinstall
      await ToolModel.deleteByCatalogId(id);

      return reply.send(catalogItem);
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
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id } }, reply) => {
      return reply.send({
        success: await InternalMcpCatalogModel.delete(id),
      });
    },
  );
};

export default internalMcpCatalogRoutes;
