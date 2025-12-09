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
      let clientSecretId: string | undefined;
      let localConfigSecretId: string | undefined;

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

      // Extract secret env vars from localConfig.environment
      if (body.localConfig?.environment) {
        const secretEnvVars: Record<string, string> = {};
        for (const envVar of body.localConfig.environment) {
          if (
            envVar.type === "secret" &&
            envVar.value &&
            !envVar.promptOnInstallation
          ) {
            secretEnvVars[envVar.key] = envVar.value;
            delete envVar.value; // Remove value from catalog template
          }
        }

        // Store secret env vars if any exist
        if (Object.keys(secretEnvVars).length > 0) {
          const secret = await secretManager.createSecret(
            secretEnvVars,
            `${body.name}-local-config-env`,
          );
          localConfigSecretId = secret.id;
          body.localConfigSecretId = localConfigSecretId;
        }
      }

      const catalogItem = await InternalMcpCatalogModel.create(body);
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
      let localConfigSecretId = originalCatalogItem.localConfigSecretId;

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

      // Extract secret env vars from localConfig.environment
      if (body.localConfig?.environment) {
        const secretEnvVars: Record<string, string> = {};

        for (const envVar of body.localConfig.environment) {
          if (
            envVar.type === "secret" &&
            envVar.value &&
            !envVar.promptOnInstallation
          ) {
            secretEnvVars[envVar.key] = envVar.value;
            delete envVar.value; // Remove value from catalog template
          }
        }

        // Store secret env vars if any exist
        if (Object.keys(secretEnvVars).length > 0) {
          if (localConfigSecretId) {
            // Update existing secret
            await secretManager.updateSecret(
              localConfigSecretId,
              secretEnvVars,
            );
          } else {
            // Create new secret
            const secret = await secretManager.createSecret(
              secretEnvVars,
              `${originalCatalogItem.name}-local-config-env`,
            );
            localConfigSecretId = secret.id;
          }
          body.localConfigSecretId = localConfigSecretId;
        }
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
      // Get the catalog item to check if it has secrets
      const catalogItem = await InternalMcpCatalogModel.findById(id);

      if (catalogItem?.clientSecretId) {
        // Delete the associated OAuth secret
        await secretManager.deleteSecret(catalogItem.clientSecretId);
      }

      if (catalogItem?.localConfigSecretId) {
        // Delete the associated local config secret
        await secretManager.deleteSecret(catalogItem.localConfigSecretId);
      }

      return reply.send({
        success: await InternalMcpCatalogModel.delete(id),
      });
    },
  );
};

export default internalMcpCatalogRoutes;
