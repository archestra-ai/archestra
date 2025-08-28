import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { ArchestraScoreBreakdown } from '@archestra/types';
import constants from '@constants';
import { loadServers } from '@lib/catalog';
import { calculateQualityScore } from '@lib/quality-calculator';
import { ApiErrorResponseSchema, ArchestraMcpServerManifestWithScoreBreakdownSchema } from '@schemas';

const { baseUrl } = constants;

const McpServerDetailResponseSchema = ArchestraMcpServerManifestWithScoreBreakdownSchema.extend({
  github_url: z.string(),
  badge_url: z.string(),
  detail_page_url: z.string(),
});

// Register schema for OpenAPI generation
z.globalRegistry.add(McpServerDetailResponseSchema, { id: 'McpServerDetailResponse' });

const serverRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/server/:name',
    {
      schema: {
        operationId: 'getServer',
        description: 'Get detailed information about a specific MCP server',
        tags: ['Server'],
        params: z.object({
          name: z.string().min(1).describe('The name of the MCP server'),
        }),
        response: {
          200: McpServerDetailResponseSchema,
          404: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { name } = request.params;

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
        let score_breakdown: ArchestraScoreBreakdown | null = null;
        if (qualityScore !== null) {
          // Load all servers for dependency commonality calculation
          const allServers = loadServers();
          score_breakdown = calculateQualityScore(server, allServers);
        }

        // Return detailed server information
        return {
          ...server,
          score_breakdown,
          // Add computed fields
          github_url: `https://github.com/${gitHubInfoOwner}/${gitHubInfoRepo}${
            gitHubInfoPath ? `/tree/main/${gitHubInfoPath}` : ''
          }`,
          badge_url: gitHubInfoPath
            ? `${baseUrl}/v1/badge/quality/${gitHubInfoOwner}/${gitHubInfoRepo}/${gitHubInfoPath.replace(/\//g, '--')}`
            : `${baseUrl}/v1/badge/quality/${gitHubInfoOwner}/${gitHubInfoRepo}`,
          detail_page_url: `https://archestra.ai/mcp-catalog/${serverName}`,
        };
      } catch (error) {
        fastify.log.error(`Server API error: ${error}`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
};

export default serverRoutes;
