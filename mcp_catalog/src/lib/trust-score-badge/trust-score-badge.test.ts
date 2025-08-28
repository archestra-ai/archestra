import { ArchestraMcpServerGitHubRepoInfo } from '@mcpCatalog/types';

import { generateBadgeMarkdown, generateBadgeRelativeUrl } from './';

describe('trustScoreBadge utils', () => {
  const serverId = 'modelcontextprotocol__servers__src__sqlite';
  const path = 'src/sqlite';
  const gitHubInfo = {
    owner: 'modelcontextprotocol',
    repo: 'servers',
    path: null,
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    name: 'servers__src__sqlite',
  } as ArchestraMcpServerGitHubRepoInfo;

  const gitHubInfoWithPath = {
    ...gitHubInfo,
    path,
  } as ArchestraMcpServerGitHubRepoInfo;

  describe('generateBadgeRelativeUrl', () => {
    it('should generate correct relative URL without path', () => {
      const result = generateBadgeRelativeUrl(gitHubInfo);
      expect(result).toBe('/mcp-catalog/api/badge/quality/modelcontextprotocol/servers');
    });

    it('should generate correct relative URL with path', () => {
      const result = generateBadgeRelativeUrl(gitHubInfoWithPath);
      expect(result).toBe('/mcp-catalog/api/badge/quality/modelcontextprotocol/servers/src--sqlite');
    });
  });

  describe('generateBadgeMarkdown', () => {
    it('should generate correct markdown', () => {
      const result = generateBadgeMarkdown(serverId, gitHubInfo);
      expect(result).toBe(
        `[![Trust Score](https://archestra.ai/mcp-catalog/api/badge/quality/modelcontextprotocol/servers)](https://archestra.ai/mcp-catalog/${serverId})`
      );
    });

    it('should generate correct markdown with path', () => {
      const result = generateBadgeMarkdown(serverId, gitHubInfoWithPath);
      expect(result).toBe(
        `[![Trust Score](https://archestra.ai/mcp-catalog/api/badge/quality/modelcontextprotocol/servers/src--sqlite)](https://archestra.ai/mcp-catalog/${serverId})`
      );
    });
  });
});
