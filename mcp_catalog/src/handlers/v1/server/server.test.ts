import fastify, { FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { ArchestraMcpServerManifest } from '@archestra/types';
import constants from '@constants';

import serverRoutes from './';

// Mock the dependencies
vi.mock('@lib/catalog', () => ({
  loadServers: vi.fn((name?: string) => {
    const allServers: ArchestraMcpServerManifest[] = [
      {
        $schema: 'https://github.com/anthropic-ai/dxt/blob/main/catalog/mcp_catalog_manifest.schema.json',
        dxt_version: '0.2.6',
        name: 'test-server-1',
        display_name: 'Test Server 1',
        version: '1.0.0',
        description: 'A test MCP server',
        long_description: 'A longer description for test server 1',
        author: { name: 'Test Author', email: 'test@example.com' },
        server: {
          type: 'node',
          entry_point: 'index.js',
          mcp_config: { command: 'node', args: ['index.js'] },
        },
        tools: [{ name: 'test-tool', description: 'A test tool' }],
        prompts: [{ name: 'test-prompt', text: 'A test prompt' }],
        readme: 'Test readme content',
        category: 'AI Tools',
        programming_language: 'TypeScript',
        quality_score: 85,
        archestra_config: {
          client_config_permutations: {
            mcpServers: {},
          },
          oauth: { provider: null, required: false },
        },
        github_info: {
          owner: 'test-org',
          repo: 'test-repo-1',
          url: 'https://github.com/test-org/test-repo-1',
          name: 'test-repo-1',
          path: null,
          stars: 100,
          contributors: 5,
          issues: 10,
          releases: true,
          ci_cd: true,
          latest_commit_hash: 'abc123',
        },
        framework: 'express',
        dependencies: [
          { name: 'axios', importance: 8 },
          { name: 'lodash', importance: 8 },
        ],
        last_scraped_at: '2024-01-01T00:00:00Z',
        evaluation_model: 'claude-3-opus',
        protocol_features: {
          implementing_tools: true,
          implementing_prompts: true,
          implementing_resources: true,
          implementing_sampling: true,
          implementing_roots: false,
          implementing_logging: false,
          implementing_stdio: true,
          implementing_streamable_http: false,
          implementing_oauth2: false,
        },
        raw_dependencies: 'axios@^1.0.0\nlodash@^4.0.0',
      },
      {
        $schema: 'https://github.com/anthropic-ai/dxt/blob/main/catalog/mcp_catalog_manifest.schema.json',
        dxt_version: '0.2.6',
        name: 'test-server-with-path',
        display_name: 'Test Server With Path',
        version: '2.0.0',
        description: 'A test MCP server with repository path',
        long_description: 'A longer description for test server with path',
        author: { name: 'Another Author' },
        server: {
          type: 'node',
          entry_point: 'index.js',
          mcp_config: { command: 'node', args: ['index.js'] },
        },
        tools: [],
        prompts: [],
        readme: 'Test readme with path',
        category: 'Cloud',
        programming_language: 'Python',
        quality_score: null,
        archestra_config: {
          client_config_permutations: {
            mcpServers: {},
          },
          oauth: { provider: null, required: false },
        },
        github_info: {
          owner: 'test-org-2',
          repo: 'test-repo-2',
          url: 'https://github.com/test-org-2/test-repo-2',
          name: 'test-repo-2',
          path: 'packages/server',
          stars: 200,
          contributors: 10,
          issues: 5,
          releases: false,
          ci_cd: false,
          latest_commit_hash: 'def456',
        },
        framework: null,
        dependencies: [],
        last_scraped_at: '2024-01-01T00:00:00Z',
        evaluation_model: 'claude-3-opus',
        protocol_features: {
          implementing_tools: false,
          implementing_prompts: false,
          implementing_resources: false,
          implementing_sampling: false,
          implementing_roots: false,
          implementing_logging: false,
          implementing_stdio: true,
          implementing_streamable_http: false,
          implementing_oauth2: false,
        },
        raw_dependencies: null,
      },
    ];

    if (!name) return allServers;
    return allServers.filter((server) => server.name === name);
  }),
}));

vi.mock('@lib/quality-calculator', () => ({
  calculateQualityScore: vi.fn(() => ({
    mcp_protocol: 35,
    github_metrics: 18,
    deployment_maturity: 16,
    documentation: 16,
    dependencies: 0,
    badge_usage: 0,
    total: 85,
  })),
}));

const { baseUrl } = constants;

describe('GET /v1/server/:name', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(serverRoutes);
    await app.ready();
  });

  it('should return server details for a valid server name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/server/test-server-1',
    });

    expect(response.statusCode).toBe(200);
    const data = response.json();

    expect(data.name).toBe('test-server-1');
    expect(data.display_name).toBe('Test Server 1');
    expect(data.quality_score).toBe(85);
    expect(data.score_breakdown).toEqual({
      mcp_protocol: 35,
      github_metrics: 18,
      deployment_maturity: 16,
      documentation: 16,
      dependencies: 0,
      badge_usage: 0,
      total: 85,
    });
    expect(data.github_url).toBe('https://github.com/test-org/test-repo-1');
    expect(data.badge_url).toBe(`${baseUrl}/v1/badge/quality/test-org/test-repo-1`);
    expect(data.detail_page_url).toBe('https://archestra.ai/mcp-catalog/test-server-1');
  });

  it('should return server details for a server with repository path', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/server/test-server-with-path',
    });

    expect(response.statusCode).toBe(200);
    const data = response.json();

    expect(data.name).toBe('test-server-with-path');
    expect(data.display_name).toBe('Test Server With Path');
    expect(data.quality_score).toBe(null);
    expect(data.score_breakdown).toBe(null);
    expect(data.github_url).toBe('https://github.com/test-org-2/test-repo-2/tree/main/packages/server');
    expect(data.badge_url).toBe(`${baseUrl}/v1/badge/quality/test-org-2/test-repo-2/packages--server`);
    expect(data.detail_page_url).toBe('https://archestra.ai/mcp-catalog/test-server-with-path');
  });

  it('should return 404 for non-existent server', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/server/non-existent',
    });

    expect(response.statusCode).toBe(404);
    const data = response.json();
    expect(data.error).toBe('Server not found');
  });

  it('should return 400 for empty server name', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/server/',
    });

    expect(response.statusCode).toBe(400);
    const data = response.json();
    expect(data).toHaveProperty('error');
  });
});
