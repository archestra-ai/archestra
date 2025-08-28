import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { loadServers } from '@lib/catalog';
import { ApiErrorResponseSchema, ArchestraMcpServerManifestSchema, McpServerCategorySchema } from '@schemas';

const SearchQuerySchema = z.object({
  q: z.string().optional().describe('Search query to filter by name, description, or repository'),
  category: McpServerCategorySchema.optional().describe('Filter by category'),
  language: z.string().optional().describe('Filter by programming language'),
  sortBy: z.enum(['quality', 'stars', 'name']).optional().describe('Sort results by field'),
  limit: z.coerce.number().int().positive().max(100).default(20).optional().describe('Number of results to return'),
  offset: z.coerce.number().int().min(0).default(0).optional().describe('Number of results to skip'),
});

const SearchResponseSchema = z.object({
  servers: z.array(ArchestraMcpServerManifestSchema),
  totalCount: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  hasMore: z.boolean(),
});

const searchRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/search',
    {
      schema: {
        operationId: 'searchServers',
        description: 'Search and filter MCP servers',
        tags: ['Search'],
        querystring: SearchQuerySchema,
        response: {
          200: SearchResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const {
          q: query = '',
          category = '',
          language = '',
          limit = 20,
          offset = 0,
          sortBy = 'quality',
        } = request.query;

        // Load all servers
        const allServers = loadServers();

        // Filter servers
        let filteredServers = allServers.filter(
          ({
            name,
            description,
            github_info: { owner, repo },
            category: serverCategory,
            programming_language: programmingLanguage,
          }) => {
            // Search query filter
            if (query) {
              const searchQuery = query.toLowerCase();
              const matchesSearch =
                name.toLowerCase().includes(searchQuery) ||
                description.toLowerCase().includes(searchQuery) ||
                owner.toLowerCase().includes(searchQuery) ||
                repo.toLowerCase().includes(searchQuery);

              if (!matchesSearch) return false;
            }

            // Category filter
            if (category && serverCategory !== category) {
              return false;
            }

            // Language filter
            if (language && programmingLanguage !== language) {
              return false;
            }

            return true;
          }
        );

        // Sort servers
        filteredServers.sort((a, b) => {
          switch (sortBy) {
            case 'quality':
              // Sort by trust score (descending), null values last
              if (a.quality_score === null && b.quality_score === null) return 0;
              if (a.quality_score === null) return 1;
              if (b.quality_score === null) return -1;
              return b.quality_score - a.quality_score;

            case 'stars':
              // Sort by GitHub stars (descending)
              return (b.github_info.stars || 0) - (a.github_info.stars || 0);

            case 'name':
              // Sort alphabetically by name
              return a.name.localeCompare(b.name);

            default:
              return 0;
          }
        });

        // Apply pagination
        const totalCount = filteredServers.length;
        const paginatedServers = filteredServers.slice(offset, offset + limit);

        return {
          servers: paginatedServers,
          totalCount,
          limit,
          offset,
          hasMore: offset + limit < totalCount,
        };
      } catch (error) {
        fastify.log.error('Search API error:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
};

export default searchRoutes;
