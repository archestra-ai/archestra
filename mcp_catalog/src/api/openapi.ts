import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { ErrorResponseSchema, SearchQuerySchema, SearchResponseSchema } from '@mcpCatalog/api/schemas';
import { ArchestraMcpServerManifestWithScoreBreakdownSchema, McpServerCategorySchema } from '@mcpCatalog/schemas';

const registry = new OpenAPIRegistry();

registry.registerPath({
  operationId: 'searchMcpServerCatalog',
  method: 'get',
  path: '/search',
  summary: 'Search MCP servers',
  description: 'Search for MCP servers with filtering and sorting options',
  tags: ['Search'],
  request: {
    query: SearchQuerySchema,
  },
  responses: {
    200: {
      description: 'Successful response',
      content: {
        'application/json': {
          schema: SearchResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  operationId: 'getMcpServer',
  method: 'get',
  path: '/server/{name}',
  summary: 'Get MCP server by name',
  description: 'Retrieve detailed information about a specific MCP server by its name identifier',
  tags: ['Server'],
  request: {
    params: z.object({
      name: z.string().describe('Server name identifier (format - org__repo or org__repo__path)'),
    }),
  },
  responses: {
    200: {
      description: 'Successful response',
      content: {
        'application/json': {
          schema: ArchestraMcpServerManifestWithScoreBreakdownSchema,
        },
      },
    },
    404: {
      description: 'Server not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  operationId: 'getMcpServerQualityBadge',
  method: 'get',
  path: '/badge/quality/{org}/{repo}',
  summary: 'Get quality badge',
  description: 'Get an SVG quality badge for an MCP server',
  tags: ['Badges'],
  request: {
    params: z.object({
      org: z.string().describe('GitHub organization'),
      repo: z.string().describe('GitHub repository name'),
    }),
  },
  responses: {
    200: {
      description: 'SVG badge image',
      content: {
        'image/svg+xml': {
          schema: z.string().describe('SVG image content'),
        },
      },
    },
    404: {
      description: 'Server not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  operationId: 'getMcpServerCategories',
  method: 'get',
  path: '/category',
  summary: 'Get available categories',
  description: 'Get a list of all available MCP server categories',
  tags: ['Categories'],
  responses: {
    200: {
      description: 'Successful response',
      content: {
        'application/json': {
          schema: z.object({
            categories: z.array(McpServerCategorySchema),
          }),
        },
      },
    },
  },
});

const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiDocument = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: 'MCP Catalog API',
    version: '1.0.0',
    description: 'API for searching and retrieving MCP server information',
  },
  servers: [
    {
      url: '/mcp-catalog/api',
      description: 'MCP Catalog API',
    },
  ],
});
