import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { InternalMcpCatalogModel, McpServerModel, ToolModel } from "@/models";
import { secretManager } from "@/secretsmanager";
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
      const catalogItems = await InternalMcpCatalogModel.findAll();
      await Promise.all(
        catalogItems.map(async (item) => {
          const clientSecretId = item.clientSecretId;
          if (!clientSecretId) {
            return;
          }
          const secret = await secretManager.getSecret(clientSecretId);
          if (secret?.secret.client_secret && item.oauthConfig) {
            item.oauthConfig.client_secret = String(
              secret.secret.client_secret,
            );
          }
        }),
      );

      return reply.send(catalogItems);
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
      let clientSecretId: string | undefined;

      // If oauthConfig has client_secret, extract it and store in secrets table
      if (body.oauthConfig && "client_secret" in body.oauthConfig) {
        const clientSecret = body.oauthConfig.client_secret;
        const secret = await secretManager.createSecret(
          { client_secret: clientSecret },
          `${body.name}-oauth-client-secret`,
        );
        clientSecretId = secret.id;

        body.clientSecretId = clientSecretId;
        delete body.oauthConfig.client_secret;
      }

      const catalogItem = await InternalMcpCatalogModel.create(body);

      // Add client_secret back to response for backward compatibility
      if (clientSecretId && catalogItem.oauthConfig) {
        const secret = await secretManager.getSecret(clientSecretId);
        if (secret?.secret.client_secret) {
          catalogItem.oauthConfig.client_secret = String(
            secret.secret.client_secret,
          );
        }
      }

      return reply.send(catalogItem);
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

      // Fetch secret and add client_secret to oauthConfig if present
      if (catalogItem.clientSecretId && catalogItem.oauthConfig) {
        const secret = await secretManager.getSecret(
          catalogItem.clientSecretId,
        );
        if (secret?.secret.client_secret) {
          catalogItem.oauthConfig.client_secret = String(
            secret.secret.client_secret,
          );
        }
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

      let clientSecretId = originalCatalogItem.clientSecretId;

      // If oauthConfig has client_secret, handle secret storage
      if (body.oauthConfig && "client_secret" in body.oauthConfig) {
        const clientSecret = body.oauthConfig.client_secret;

        if (clientSecretId) {
          // Update existing secret
          await secretManager.updateSecret(clientSecretId, {
            client_secret: clientSecret,
          });
        } else {
          // Create new secret
          const secret = await secretManager.createSecret(
            { client_secret: clientSecret },
            `${originalCatalogItem.name}-oauth-client-secret`,
          );
          clientSecretId = secret.id;
        }

        body.clientSecretId = clientSecretId;
        delete body.oauthConfig.client_secret;
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

      // Add client_secret back to response for backward compatibility
      if (catalogItem.clientSecretId && catalogItem.oauthConfig) {
        const secret = await secretManager.getSecret(
          catalogItem.clientSecretId,
        );
        if (secret?.secret.client_secret) {
          catalogItem.oauthConfig.client_secret = String(
            secret.secret.client_secret,
          );
        }
      }

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
      // Get the catalog item to check if it has a secret
      const catalogItem = await InternalMcpCatalogModel.findById(id);

      if (catalogItem?.clientSecretId) {
        // Delete the associated secret
        await secretManager.deleteSecret(catalogItem.clientSecretId);
      }

      return reply.send({
        success: await InternalMcpCatalogModel.delete(id),
      });
    },
  );
};

export default internalMcpCatalogRoutes;
