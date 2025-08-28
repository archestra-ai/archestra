import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { ArchestraMcpServerManifest } from '@mcpCatalog/types';

import { GET } from './route';

// Mock loadServers to return predictable test data
vi.mock('@mcpCatalog/lib/catalog', () => ({
  loadServers: (): ArchestraMcpServerManifest[] => [
    {
      $schema: 'https://github.com/anthropic-ai/dxt/blob/main/catalog/mcp_catalog_manifest.schema.json',
      dxt_version: '0.2.6',
      name: 'test-server-1',
      display_name: 'Test Server 1',
      version: '1.0.0',
      description: 'A test MCP server',
      long_description: 'A longer description',
      author: { name: 'Test Author' },
      server: {
        type: 'node',
        entry_point: 'index.js',
        mcp_config: { command: 'node', args: ['index.js'] },
      },
      tools: [],
      prompts: [],
      readme: 'Test readme',
      category: 'AI Tools',
      programming_language: 'TypeScript',
      quality_score: 90,
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
      last_scraped_at: '2024-01-01',
      evaluation_model: 'claude-3',
      protocol_features: {
        implementing_tools: true,
        implementing_prompts: false,
        implementing_resources: false,
        implementing_sampling: false,
        implementing_roots: false,
        implementing_logging: false,
        implementing_stdio: true,
        implementing_streamable_http: false,
        implementing_oauth2: false,
      },
      dependencies: [],
      raw_dependencies: '{}',
    },
    {
      $schema: 'https://github.com/anthropic-ai/dxt/blob/main/catalog/mcp_catalog_manifest.schema.json',
      dxt_version: '0.2.6',
      name: 'test-server-2',
      display_name: 'Test Server 2',
      version: '2.0.0',
      description: 'Another test server',
      long_description: 'Another longer description',
      author: { name: 'Test Author 2' },
      server: {
        type: 'python',
        entry_point: 'main.py',
        mcp_config: { command: 'python', args: ['main.py'] },
      },
      tools: [],
      prompts: [],
      readme: 'Test readme 2',
      category: 'Development',
      programming_language: 'Python',
      quality_score: 85,
      archestra_config: {
        client_config_permutations: {
          mcpServers: {},
        },
        oauth: { provider: null, required: false },
      },
      github_info: {
        owner: 'test-org',
        repo: 'test-repo-2',
        url: 'https://github.com/test-org/test-repo-2',
        name: 'test-repo-2',
        path: null,
        stars: 50,
        contributors: 3,
        issues: 5,
        releases: false,
        ci_cd: false,
        latest_commit_hash: 'def456',
      },
      framework: 'flask',
      last_scraped_at: '2024-01-01',
      evaluation_model: 'claude-3',
      protocol_features: {
        implementing_tools: false,
        implementing_prompts: true,
        implementing_resources: false,
        implementing_sampling: false,
        implementing_roots: false,
        implementing_logging: false,
        implementing_stdio: true,
        implementing_streamable_http: false,
        implementing_oauth2: false,
      },
      dependencies: [],
      raw_dependencies: '{}',
    },
  ],
}));

describe('GET /mcp-catalog/api/search', () => {
  const createRequest = (params?: Record<string, string>) => {
    const url = new URL('http://localhost:3000/mcp-catalog/api/search');
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }
    return new NextRequest(url);
  };

  it('should return all servers when no filters are applied', async () => {
    const request = createRequest();
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveProperty('servers');
    expect(data.servers).toHaveLength(2);
    expect(data).toHaveProperty('totalCount', 2);
    expect(data).toHaveProperty('hasMore', false);
  });

  it('should filter servers by search query', async () => {
    const request = createRequest({ q: 'test-server-1' });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].name).toBe('test-server-1');
  });

  it('should filter servers by category', async () => {
    const request = createRequest({ category: 'AI Tools' });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].category).toBe('AI Tools');
  });

  it('should filter servers by language', async () => {
    const request = createRequest({ language: 'Python' });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].programming_language).toBe('Python');
  });

  it('should apply pagination', async () => {
    const request = createRequest({ limit: '1', offset: '0' });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.servers).toHaveLength(1);
    expect(data.totalCount).toBe(2);
    expect(data.hasMore).toBe(true);
    expect(data.limit).toBe(1);
    expect(data.offset).toBe(0);
  });

  it('should sort servers by quality score', async () => {
    const request = createRequest({ sortBy: 'quality' });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.servers[0].quality_score).toBe(90);
    expect(data.servers[1].quality_score).toBe(85);
  });

  it('should return 400 for invalid query parameters', async () => {
    const request = createRequest({ limit: 'invalid' });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toHaveProperty('error');
    expect(data).toHaveProperty('details');
  });
});
