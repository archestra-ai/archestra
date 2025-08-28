import type { ArchestraMcpServerManifest } from '@mcpCatalog/types';

import {
  calculateBadgeUsageScore,
  calculateDependenciesScore,
  calculateDeploymentMaturityScore,
  calculateDocumentationScore,
  calculateGitHubMetricsScore,
  calculateMCPProtocolScore,
  calculateQualityScore,
} from './';

function createBaseServerManifest(overrides?: Partial<ArchestraMcpServerManifest>): ArchestraMcpServerManifest {
  return {
    dxt_version: '1.0.0',
    name: 'test-server',
    version: '1.0.0',
    display_name: 'Test Server',
    description: 'A test MCP server',
    readme: null,
    category: 'Development',
    quality_score: null,
    author: {
      name: 'Test Author',
    },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: {
        command: 'node',
        args: ['server/index.js'],
      },
    },
    archestra_config: {
      client_config_permutations: {
        mcpServers: {},
      },
      oauth: {
        provider: null,
        required: false,
      },
    },
    github_info: {
      owner: 'test-owner',
      repo: 'test-repo',
      url: 'https://github.com/test-owner/test-repo',
      name: 'test-repo',
      path: null,
      stars: 0,
      contributors: 1,
      issues: 0,
      releases: false,
      ci_cd: false,
      latest_commit_hash: null,
    },
    programming_language: 'TypeScript',
    framework: 'node',
    last_scraped_at: '2024-01-01',
    evaluation_model: 'claude-3-opus-20240229',
    protocol_features: {
      implementing_tools: false,
      implementing_prompts: false,
      implementing_resources: false,
      implementing_sampling: false,
      implementing_roots: false,
      implementing_logging: false,
      implementing_stdio: false,
      implementing_streamable_http: false,
      implementing_oauth2: false,
    },
    dependencies: [],
    raw_dependencies: null,
    ...overrides,
  };
}

describe('Quality Calculator', () => {
  describe('calculateMCPProtocolScore', () => {
    it('should return maximum score (40 points) when all protocol features are implemented', () => {
      const server = createBaseServerManifest({
        protocol_features: {
          implementing_tools: true,
          implementing_resources: true,
          implementing_prompts: true,
          implementing_sampling: true,
          implementing_stdio: true,
          implementing_streamable_http: true,
          implementing_roots: true,
          implementing_logging: true,
          implementing_oauth2: true,
        },
      });

      const score = calculateMCPProtocolScore(server);
      expect(score).toBe(40);
    });

    it('should return 35 points for unevaluated servers (empty protocol features)', () => {
      const server = createBaseServerManifest({
        protocol_features: {} as any,
      });

      const score = calculateMCPProtocolScore(server);
      expect(score).toBe(35);
    });
  });

  describe('calculateGitHubMetricsScore', () => {
    it('should return maximum score (20 points) for highly popular repositories', () => {
      const server = createBaseServerManifest({
        github_info: {
          owner: 'popular-owner',
          repo: 'popular-repo',
          url: 'https://github.com/popular-owner/popular-repo',
          name: 'popular-repo',
          path: null,
          stars: 2000,
          contributors: 25,
          issues: 50,
          releases: true,
          ci_cd: true,
          latest_commit_hash: 'abc123',
        },
      });

      const score = calculateGitHubMetricsScore(server);
      expect(score).toBe(20);
    });

    it('should properly adjust metrics for multi-server repositories', () => {
      const server = createBaseServerManifest({
        github_info: {
          owner: 'multi-owner',
          repo: 'multi-repo',
          url: 'https://github.com/multi-owner/multi-repo',
          name: 'multi-repo',
          path: null,
          stars: 4000,
          contributors: 50,
          issues: 100,
          releases: true,
          ci_cd: true,
          latest_commit_hash: 'abc123',
        },
      });

      const allServers = [
        server,
        createBaseServerManifest({
          name: 'test-server-2',
          github_info: {
            ...server.github_info,
          },
        }),
      ];

      const score = calculateGitHubMetricsScore(server, allServers);
      // Stars: 4000/2 = 2000 -> 10 points
      // Contributors: 50/2 = 25 -> 6 points
      // Issues: 100/2 = 50 -> 4 points
      expect(score).toBe(20);
    });
  });

  describe('calculateDeploymentMaturityScore', () => {
    it('should return maximum score (10 points) when both CI/CD and releases are present', () => {
      const server = createBaseServerManifest({
        github_info: {
          ...createBaseServerManifest().github_info,
          ci_cd: true,
          releases: true,
        },
      });

      const score = calculateDeploymentMaturityScore(server);
      expect(score).toBe(10);
    });
  });

  describe('calculateDocumentationScore', () => {
    it('should return maximum score (8 points) for comprehensive documentation', () => {
      const server = createBaseServerManifest({
        readme:
          'This is a comprehensive README with more than 100 characters explaining how to use this MCP server, its features, installation instructions, and API documentation.',
      });

      const score = calculateDocumentationScore(server);
      expect(score).toBe(8);
    });
  });

  describe('calculateDependenciesScore', () => {
    it('should return maximum score (20 points) for servers with no dependencies', () => {
      const server = createBaseServerManifest({
        dependencies: [],
      });

      const score = calculateDependenciesScore(server);
      expect(score).toBe(20);
    });

    it('should return 20 points for servers with few common dependencies', () => {
      const server = createBaseServerManifest({
        dependencies: [
          { name: 'axios', importance: 8 },
          { name: 'lodash', importance: 6 },
        ],
      });

      const score = calculateDependenciesScore(server);
      expect(score).toBe(20);
    });

    it('should give partial credit (15 points) for unevaluated dependencies', () => {
      const server = createBaseServerManifest({
        dependencies: null as any,
      });

      const score = calculateDependenciesScore(server);
      expect(score).toBe(15);
    });
  });

  describe('calculateBadgeUsageScore', () => {
    it('should return maximum score (2 points) when Archestra badge is present in README', () => {
      const server = createBaseServerManifest({
        readme: `# My MCP Server

[![MCP Quality](https://archestra.ai/api/badge/quality/my-org/my-repo)](https://archestra.ai/mcp-catalog/my-server)

This server implements the Model Context Protocol.`,
      });

      const score = calculateBadgeUsageScore(server);
      expect(score).toBe(2);
    });

    it('should detect different badge variations', () => {
      const variations = [
        '[![MCP Trust](https://archestra.ai/api/badge/quality/org/repo)](link)',
        '[![Trust Score](https://archestra.ai/api/badge/quality/org/repo)](link)',
        '[![mcp quality](https://archestra.ai/api/badge/quality/org/repo)](link)',
      ];

      variations.forEach((badgeText) => {
        const server = createBaseServerManifest({
          readme: `# README\n\n${badgeText}\n\nDescription here.`,
        });
        const score = calculateBadgeUsageScore(server);
        expect(score).toBe(2);
      });
    });
  });

  describe('calculateQualityScore', () => {
    it('should return perfect score (100 points) for an ideal MCP server', () => {
      const perfectServer = createBaseServerManifest({
        readme: `# Perfect MCP Server

[![MCP Quality](https://archestra.ai/api/badge/quality/perfect/server)](https://archestra.ai/mcp-catalog/perfect-server)

This is a comprehensive README with detailed documentation, installation instructions, API reference, and examples.`,
        protocol_features: {
          implementing_tools: true,
          implementing_resources: true,
          implementing_prompts: true,
          implementing_sampling: true,
          implementing_stdio: true,
          implementing_streamable_http: true,
          implementing_roots: true,
          implementing_logging: true,
          implementing_oauth2: true,
        },
        github_info: {
          owner: 'perfect-owner',
          repo: 'perfect-repo',
          url: 'https://github.com/perfect-owner/perfect-repo',
          name: 'perfect-repo',
          path: null,
          stars: 5000,
          contributors: 50,
          issues: 100,
          releases: true,
          ci_cd: true,
          latest_commit_hash: 'abc123',
        },
        dependencies: [],
      });

      const scoreBreakdown = calculateQualityScore(perfectServer);

      expect(scoreBreakdown).toEqual({
        mcp_protocol: 40,
        github_metrics: 20,
        deployment_maturity: 10,
        documentation: 8,
        dependencies: 20,
        badge_usage: 2,
        total: 100,
      });
    });

    it('should correctly sum up all component scores', () => {
      const server = createBaseServerManifest({
        readme:
          'This is a comprehensive README file with more than 100 characters that explains the MCP server functionality',
        protocol_features: {
          implementing_tools: true,
          implementing_resources: true,
          implementing_prompts: false,
          implementing_sampling: false,
          implementing_stdio: true,
          implementing_streamable_http: false,
          implementing_roots: false,
          implementing_logging: false,
          implementing_oauth2: false,
        },
        github_info: {
          ...createBaseServerManifest().github_info,
          stars: 150,
          contributors: 5,
          issues: 10,
          releases: true,
          ci_cd: false,
        },
        dependencies: [
          { name: 'express', importance: 8 },
          { name: 'dotenv', importance: 5 },
        ],
      });

      const scoreBreakdown = calculateQualityScore(server);

      // Verify individual scores
      expect(scoreBreakdown.mcp_protocol).toBe(20); // tools(8) + resources(8) + stdio(4)
      expect(scoreBreakdown.github_metrics).toBe(12); // stars(6) + contributors(4) + issues(2)
      expect(scoreBreakdown.deployment_maturity).toBe(5); // releases(5) only
      expect(scoreBreakdown.documentation).toBe(8); // has readme > 100 chars
      expect(scoreBreakdown.dependencies).toBe(20); // only 2 deps, both common
      expect(scoreBreakdown.badge_usage).toBe(0); // no badge

      // Verify total
      expect(scoreBreakdown.total).toBe(65);
    });
  });
});
