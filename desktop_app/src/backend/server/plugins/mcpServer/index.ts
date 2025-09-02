import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

import {
  McpServerConfigSchema,
  McpServerSchema,
  McpServerUserConfigValuesSchema,
} from '@backend/database/schema/mcpServer';
import toolAggregator from '@backend/llms/toolAggregator';
import McpRequestLog from '@backend/models/mcpRequestLog';
import McpServerModel, { McpServerInstallSchema } from '@backend/models/mcpServer';
import McpServerSandboxManager from '@backend/sandbox/manager';
import { AvailableToolSchema, McpServerContainerLogsSchema } from '@backend/sandbox/sandboxedMcp';
import { ErrorResponseSchema } from '@backend/schemas';
import log from '@backend/utils/logger';

/**
 * Register our zod schemas into the global registry, such that they get output as components in the openapi spec
 * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-create-refs-to-the-schemas
 */
// Register base schemas first - these have no dependencies
z.globalRegistry.add(McpServerConfigSchema, { id: 'McpServerConfig' });
z.globalRegistry.add(McpServerUserConfigValuesSchema, { id: 'McpServerUserConfigValues' });

// Then register schemas that depend on base schemas
z.globalRegistry.add(McpServerSchema, { id: 'McpServer' });
z.globalRegistry.add(McpServerInstallSchema, { id: 'McpServerInstall' });
z.globalRegistry.add(McpServerContainerLogsSchema, { id: 'McpServerContainerLogs' });
z.globalRegistry.add(AvailableToolSchema, { id: 'AvailableTool' });

// Schema for catalog search parameters
const CatalogSearchParamsSchema = z.object({
  q: z.string().optional().describe('Search query'),
  category: z.string().optional().describe('Filter by category'),
  limit: z.number().int().positive().default(24).optional().describe('Number of results to return'),
  offset: z.number().int().min(0).default(0).optional().describe('Offset for pagination'),
});

// Schema for catalog server manifest (simplified version)
const CatalogServerManifestSchema = z.object({
  name: z.string(),
  display_name: z.string(),
  description: z.string(),
  category: z.string(),
  author: z.string().optional(),
  license: z.string().optional(),
  tags: z.array(z.string()).optional(),
  archestra_config: z.record(z.string(), z.unknown()).optional(),
});

// Schema for catalog search response
const CatalogSearchResponseSchema = z.object({
  servers: z.array(CatalogServerManifestSchema).describe('Array of MCP server manifests'),
  hasMore: z.boolean().describe('Whether there are more results available'),
  totalCount: z.number().int().describe('Total number of matching servers'),
});

z.globalRegistry.add(CatalogServerManifestSchema, { id: 'CatalogServerManifest' });
z.globalRegistry.add(CatalogSearchParamsSchema, { id: 'CatalogSearchParams' });
z.globalRegistry.add(CatalogSearchResponseSchema, { id: 'CatalogSearchResponse' });

const mcpServerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/api/mcp_server',
    {
      schema: {
        operationId: 'getMcpServers',
        description: 'Get all installed MCP servers',
        tags: ['MCP Server'],
        response: {
          200: z.array(McpServerSchema),
        },
      },
    },
    async (_request, reply) => {
      const servers = await McpServerModel.getInstalledMcpServers();
      return reply.send(servers);
    }
  );

  fastify.get(
    '/api/mcp_server/catalog/search',
    {
      schema: {
        operationId: 'searchMcpServerCatalog',
        description: 'Search for MCP servers in the catalog',
        tags: ['MCP Server'],
        querystring: CatalogSearchParamsSchema,
        response: {
          200: CatalogSearchResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ query }, reply) => {
      try {
        const response = await McpServerModel.searchCatalog(query);
        return reply.send(response);
      } catch (error: any) {
        log.error('Failed to search MCP server catalog:', error);
        return reply.code(500).send({ error: 'Failed to search catalog' });
      }
    }
  );

  fastify.post(
    '/api/mcp_server/install',
    {
      schema: {
        operationId: 'installMcpServer',
        description: 'Install an MCP server. Either from the catalog, or a customer server',
        tags: ['MCP Server'],
        body: McpServerInstallSchema,
        response: {
          200: McpServerSchema,
          400: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async ({ body }, reply) => {
      try {
        const server = await McpServerModel.installMcpServer(body);
        return reply.code(200).send(server);
      } catch (error: any) {
        log.error('Failed to install MCP server:', error);

        if (error.message?.includes('already installed')) {
          return reply.code(400).send({ error: error.message });
        }

        return reply.code(500).send({ error: 'Internal server error' });
      }
    }
  );

  fastify.delete(
    '/api/mcp_server/:id',
    {
      schema: {
        operationId: 'uninstallMcpServer',
        description: 'Uninstall MCP server',
        tags: ['MCP Server'],
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: z.object({ success: z.boolean() }),
        },
      },
    },
    async ({ params: { id } }, reply) => {
      await McpServerModel.uninstallMcpServer(id);
      return reply.code(200).send({ success: true });
    }
  );

  /**
   * Relevant docs:
   *
   * Fastify reply.hijack() docs: https://fastify.dev/docs/latest/Reference/Reply/#hijack
   * Excluding a route from the openapi spec: https://stackoverflow.com/questions/73950993/fastify-swagger-exclude-certain-routes
   */
  fastify.post(
    '/mcp_proxy/:id',
    {
      schema: {
        hide: true,
        description: 'Proxy requests to the containerized MCP server running in the Archestra.ai sandbox',
        tags: ['MCP Server'],
        params: z.object({
          id: z.string(),
        }),
        body: z
          .object({
            jsonrpc: z.string().optional(),
            id: z.union([z.string(), z.number()]).optional(),
            method: z.string().optional(),
            params: z.any().optional(),
            sessionId: z.string().optional(),
            mcpSessionId: z.string().optional(),
          })
          .passthrough(),
      },
    },
    async ({ params: { id }, body, headers }, reply) => {
      const sandboxedMcpServer = McpServerSandboxManager.getSandboxedMcpServer(id);
      if (!sandboxedMcpServer) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }
      const { name: mcpServerName } = sandboxedMcpServer.mcpServer;

      // Create MCP request log entry
      const requestId = uuidv4();
      const startTime = Date.now();
      let responseBody: string | null = null;
      let statusCode = 200;
      let errorMessage: string | null = null;

      try {
        fastify.log.info(`Proxying request to MCP server ${id}: ${JSON.stringify(body)}`);

        // Hijack the response to handle streaming manually!
        reply.hijack();

        // Set up streaming response headers!
        reply.raw.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        });

        // Create a custom writable stream to capture the response
        const responseChunks: Buffer[] = [];
        const originalWrite = reply.raw.write.bind(reply.raw);
        const originalEnd = reply.raw.end.bind(reply.raw);

        reply.raw.write = function (chunk: any, encoding?: any) {
          if (chunk) {
            responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          return originalWrite(chunk, encoding);
        };

        reply.raw.end = function (chunk?: any, encoding?: any) {
          if (chunk) {
            responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          responseBody = Buffer.concat(responseChunks).toString('utf-8');

          // Log the successful request
          McpRequestLog.create({
            requestId,
            sessionId: body.sessionId || null,
            mcpSessionId: body.mcpSessionId || null,
            serverName: mcpServerName || id,
            clientInfo: {
              userAgent: headers['user-agent'],
              clientName: 'Archestra Desktop App',
              clientVersion: '0.0.1',
              clientPlatform: process.platform,
            },
            method: body.method || null,
            requestHeaders: headers as Record<string, string>,
            requestBody: JSON.stringify(body),
            responseBody,
            responseHeaders: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache',
            },
            statusCode,
            errorMessage: null,
            durationMs: Date.now() - startTime,
          }).catch((err) => {
            fastify.log.error('Failed to create MCP request log:', err);
          });

          return originalEnd(chunk, encoding);
        };

        // Stream the request to the container!
        await sandboxedMcpServer.streamToContainer(body, reply.raw);

        // Return undefined when hijacking to prevent Fastify from sending response
        return;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : 'No stack trace';

        statusCode = 500;
        errorMessage = errorMsg;

        fastify.log.error(`Error proxying to MCP server ${id}: ${errorMsg}`);
        fastify.log.error(`Error stack trace: ${errorStack}`);

        // Log the failed request
        await McpRequestLog.create({
          requestId,
          sessionId: body.sessionId || null,
          mcpSessionId: body.mcpSessionId || null,
          serverName: mcpServerName || id,
          clientInfo: {
            userAgent: headers['user-agent'],
            clientName: 'Archestra Desktop App',
            clientVersion: '0.0.1',
            clientPlatform: process.platform,
          },
          method: body.method || null,
          requestHeaders: headers as Record<string, string>,
          requestBody: JSON.stringify(body),
          responseBody: JSON.stringify({ error: errorMsg }),
          responseHeaders: {},
          statusCode,
          errorMessage,
          durationMs: Date.now() - startTime,
        });

        // If we haven't sent yet, we can still send error response
        if (!reply.sent) {
          return reply.code(500).send({
            error: error instanceof Error ? error.message : 'Failed to proxy request to MCP server',
          });
        } else if (!reply.raw.headersSent) {
          // If already hijacked, try to write error to raw response
          reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
          reply.raw.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : 'Failed to proxy request to MCP server',
            })
          );
        }
      }
    }
  );

  fastify.get(
    '/mcp_proxy/:id/logs',
    {
      schema: {
        operationId: 'getMcpServerLogs',
        description: 'Get logs for a specific MCP server container',
        tags: ['MCP Server'],
        params: z.object({
          id: z.string(),
        }),
        querystring: z.object({
          lines: z.coerce.number().optional().default(100),
        }),
        response: {
          200: McpServerContainerLogsSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async ({ params: { id }, query: { lines } }, reply) => {
      const sandboxedMcpServer = McpServerSandboxManager.getSandboxedMcpServer(id);
      if (!sandboxedMcpServer) {
        return reply.code(404).send({ error: 'MCP server not found' });
      }

      try {
        const logs = await sandboxedMcpServer.getMcpServerLogs(lines);
        return reply.send(logs);
      } catch (error) {
        fastify.log.error(`Error getting logs for MCP server ${id}: ${error}`);
        return reply.code(404).send({
          error: error instanceof Error ? error.message : 'Failed to get logs',
        });
      }
    }
  );

  fastify.get(
    '/api/mcp_server/tools',
    {
      schema: {
        operationId: 'getAvailableTools',
        description: 'Get all available tools from connected MCP servers',
        tags: ['MCP Server'],
        response: {
          200: z.array(AvailableToolSchema),
        },
      },
    },
    async (_request, reply) => {
      // Get tools from both sandboxed servers and Archestra MCP server
      return reply.send(toolAggregator.getAllAvailableTools());
    }
  );
};

export default mcpServerRoutes;
