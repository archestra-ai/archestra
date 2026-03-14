import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import mcpClient from "@/clients/mcp-client";
import logger from "@/logging";
import {
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { constructResponseSchema, UuidIdSchema } from "@/types";

// =============================================================================
// MCP Apps resource endpoint
// Allows the frontend to fetch UI resources (HTML) from upstream MCP servers
// =============================================================================

const mcpAppsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Get MCP Apps metadata for an agent's tools
  // Returns _meta.ui info for tools that support MCP Apps
  fastify.get(
    "/api/mcp-apps/tools/:agentId",
    {
      schema: {
        operationId: RouteId.GetMcpAppsToolMeta,
        description: "Get MCP Apps metadata for agent tools",
        tags: ["mcp-apps"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        response: constructResponseSchema(
          z.record(
            z.string(),
            z.object({
              ui: z
                .object({
                  resourceUri: z.string().optional(),
                  visibility: z.array(z.string()).optional(),
                  csp: z.record(z.string(), z.unknown()).optional(),
                  permissions: z.record(z.string(), z.unknown()).optional(),
                  prefersBorder: z.boolean().optional(),
                })
                .optional(),
            }),
          ),
        ),
      },
    },
    async (request) => {
      const { agentId } = request.params;

      logger.info({ agentId }, "Fetching MCP Apps tool metadata");

      const metaMap: Record<
        string,
        { ui?: Record<string, unknown> }
      > = {};

      // Get unique catalog IDs from the agent's tools
      const mcpTools = await ToolModel.getMcpToolsByAgent(agentId);
      const catalogIds = [
        ...new Set(
          mcpTools.filter((t) => t.catalogId).map((t) => t.catalogId!),
        ),
      ];

      for (const catalogId of catalogIds) {
        try {
          const catalogItem =
            await InternalMcpCatalogModel.findById(catalogId);
          if (!catalogItem) continue;

          const mcpServers =
            await McpServerModel.findByCatalogId(catalogId);
          if (mcpServers.length === 0) continue;

          const server = mcpServers[0];
          const secretRecord = server.secretId
            ? await secretManager().getSecret(server.secretId)
            : null;
          const secrets = secretRecord?.secret ?? {};

          // Use inspectServer to list tools with full metadata
          const result = await mcpClient.inspectServer({
            catalogItem,
            mcpServerId: server.id,
            secrets,
            method: "tools/list",
          });

          // biome-ignore lint/suspicious/noExplicitAny: inspectServer returns dynamic results
          const toolsResult = result as any;
          if (toolsResult?.tools) {
            for (const tool of toolsResult.tools) {
              if (tool._meta?.ui) {
                const fullName = `${catalogItem.name}__${tool.name}`;
                metaMap[fullName] = { ui: tool._meta.ui };
              }
            }
          }
        } catch (error) {
          logger.debug(
            {
              catalogId,
              err: error instanceof Error ? error.message : String(error),
            },
            "Failed to fetch MCP Apps metadata for catalog (non-fatal)",
          );
        }
      }

      return metaMap;
    },
  );

  // Fetch UI resource content from upstream MCP server
  fastify.post(
    "/api/mcp-apps/resource",
    {
      schema: {
        operationId: RouteId.GetMcpAppResource,
        description: "Fetch MCP App UI resource from upstream MCP server",
        tags: ["mcp-apps"],
        body: z.object({
          agentId: UuidIdSchema,
          uri: z.string().startsWith("ui://"),
        }),
        response: constructResponseSchema(
          z.object({
            uri: z.string(),
            mimeType: z.string(),
            text: z.string().optional(),
            blob: z.string().optional(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { agentId, uri } = request.body;

      logger.info(
        { agentId, uri },
        "MCP Apps resource request",
      );

      // Get unique catalog IDs from the agent's tools
      const mcpTools = await ToolModel.getMcpToolsByAgent(agentId);
      const catalogIds = [
        ...new Set(
          mcpTools.filter((t) => t.catalogId).map((t) => t.catalogId!),
        ),
      ];

      for (const catalogId of catalogIds) {
        try {
          const catalogItem =
            await InternalMcpCatalogModel.findById(catalogId);
          if (!catalogItem) continue;

          const mcpServers =
            await McpServerModel.findByCatalogId(catalogId);
          if (mcpServers.length === 0) continue;

          const server = mcpServers[0];
          const secretRecord = server.secretId
            ? await secretManager().getSecret(server.secretId)
            : null;
          const secrets = secretRecord?.secret ?? {};

          const result = await mcpClient.readResource({
            catalogItem,
            mcpServerId: server.id,
            secrets,
            uri,
          });

          if (result) {
            return result;
          }
        } catch (error) {
          logger.debug(
            {
              catalogId,
              uri,
              err: error instanceof Error ? error.message : String(error),
            },
            "Resource not found on this server, trying next",
          );
        }
      }

      reply.status(404);
      return {
        error: {
          message: `Resource not found: ${uri}`,
          type: "not_found",
        },
      };
    },
  );
};

export default mcpAppsRoutes;
