import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { loadServers } from '@lib/catalog';
import { calculateQualityScore } from '@lib/quality-calculator';
import { ApiErrorResponseSchema, ArchestraMcpServerManifestWithScoreBreakdownSchema } from '@schemas';

const ServerResponseSchema = ArchestraMcpServerManifestWithScoreBreakdownSchema.extend({
  github_url: z.string(),
  badge_url: z.string(),
  detail_page_url: z.string(),
});

const serverRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/server/:name',
    {
      schema: {
        operationId: 'getServer',
        description: 'Get detailed information about a specific MCP server',
        tags: ['Server'],
        params: z.object({
          name: z.string().describe('The name of the MCP server'),
        }),
        response: {
          200: ServerResponseSchema,
          400: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { name } = request.params;

        if (!name) {
          return reply.status(400).send({ error: 'Server name is required' });
        }

        // Load servers by name
        const servers = loadServers(name);
        const server = servers[0];

        if (!server) {
          return reply.status(404).send({ error: 'Server not found' });
        }

        const {
          name: serverName,
          quality_score: qualityScore,
          github_info: { owner: gitHubInfoOwner, repo: gitHubInfoRepo, path: gitHubInfoPath },
        } = server;

        // Calculate trust score breakdown if score exists
        let scoreBreakdown = null;
        if (qualityScore !== null) {
          // Load all servers for dependency commonality calculation
          const allServers = loadServers();
          scoreBreakdown = calculateQualityScore(server, allServers);
        }

        // Return detailed server information
        return {
          ...server,
          scoreBreakdown,
          // Add computed fields
          githubUrl: `https://github.com/${gitHubInfoOwner}/${gitHubInfoRepo}${
            gitHubInfoPath ? `/tree/main/${gitHubInfoPath}` : ''
          }`,
          badgeUrl: gitHubInfoPath
            ? `https://archestra.ai/mcp-catalog/api/badge/quality/${gitHubInfoOwner}/${gitHubInfoRepo}/${gitHubInfoPath.replace(
                /\//g,
                '--'
              )}`
            : `https://archestra.ai/mcp-catalog/api/badge/quality/${gitHubInfoOwner}/${gitHubInfoRepo}`,
          detailPageUrl: `https://archestra.ai/mcp-catalog/${serverName}`,
        };
      } catch (error) {
        fastify.log.error('Server API error:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
};

export default serverRoutes;
