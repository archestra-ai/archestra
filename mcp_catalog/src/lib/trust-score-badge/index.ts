import constants from '@constants';
import { generateMcpCatalogDetailPageUrl } from '@mcpCatalog/lib/urls';
import { ArchestraMcpServerGitHubRepoInfo } from '@mcpCatalog/types';

const {
  website: {
    urls: { base: websiteBaseUrl },
  },
} = constants;

export const generateBadgeRelativeUrl = ({ owner, repo, path }: ArchestraMcpServerGitHubRepoInfo) => {
  let pathSuffix = `${owner}/${repo}`;
  if (path) {
    pathSuffix += `/${path.replace(/\//g, '--')}`;
  }

  return `/mcp-catalog/api/badge/quality/${pathSuffix}`;
};

export const generateBadgeMarkdown = (serverId: string, gitHubInfo: ArchestraMcpServerGitHubRepoInfo) => {
  const badgeUrl = `${websiteBaseUrl}${generateBadgeRelativeUrl(gitHubInfo)}`;
  const mcpCatalogDetailPageUrl = generateMcpCatalogDetailPageUrl(serverId);
  return `[![Trust Score](${badgeUrl})](${mcpCatalogDetailPageUrl})`;
};
