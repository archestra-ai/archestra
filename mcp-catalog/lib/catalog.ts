import fs from 'fs';
import path from 'path';

import { ArchestraMcpServerManifest } from '@mcpCatalog/types';

/**
 * Path constants
 * NOTE: process.cwd() will be relative to the root of the project (/app folder)
 */
const DATA_DIR = path.join(__dirname, '../data');
const MCP_SERVERS_EVALUATIONS_DIR = path.join(DATA_DIR, 'mcp-evaluations');
const MCP_SERVERS_JSON_FILE_PATH = path.join(DATA_DIR, 'mcp-servers.json');

// Cache for loaded servers
const serversCache = new Map<string, ArchestraMcpServerManifest[]>();
const CACHE_KEY_ALL = '__ALL_SERVERS__';

// Clear the cache (useful for development or when data changes)
function clearServersCache(): void {
  serversCache.clear();
}

// Hostnames treated as git-hosted (repository) catalog entries. Compare exact
// hostnames rather than substrings so lookalike URLs (e.g.
// https://github.com.evil.example) are not misclassified as GitHub repos.
const GIT_HOST_HOSTNAMES = ['github.com', 'www.github.com', 'gitlab.com', 'www.gitlab.com'];

function isGitHostUrl(url: string): boolean {
  try {
    return GIT_HOST_HOSTNAMES.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Extract server info and generate name from URL (GitHub or remote MCP)
export function extractServerInfo(url: string): {
  gitHubOrg: string;
  gitHubRepo: string;
  name: string;
  repositoryPath: string | null;
  isRemote: boolean;
  remoteUrl?: string;
} {
  try {
    const cleanUrl = url.replace(/\/$/, ''); // Remove trailing slash

    // Check if this is a GitHub URL
    if (isGitHostUrl(cleanUrl)) {
      const parts = cleanUrl.split('/');

      // Ensure we have enough parts for a GitHub URL
      if (parts.length < 5) {
        console.warn(`Invalid GitHub URL format: ${url}`);
        const fallbackName = url.split('/').pop() || 'unknown';
        return {
          gitHubOrg: 'unknown',
          gitHubRepo: fallbackName,
          name: fallbackName,
          repositoryPath: null,
          isRemote: false,
        };
      }

      const gitHubOrg = parts[3] || 'unknown';
      const gitHubRepo = parts[4] || 'unknown';

      // Handle different GitHub URL patterns
      if (cleanUrl.includes('/tree/') || cleanUrl.includes('/blob/')) {
        // URLs like https://github.com/owner/repo/tree/main/path
        const repoEndIndex = parts.findIndex((p) => p === 'tree' || p === 'blob');
        const pathParts = parts.slice(repoEndIndex + 2).filter((p) => p);
        const repositoryPath = pathParts.length > 0 ? pathParts.join('/') : null;
        const name = `${gitHubOrg}__${gitHubRepo}${repositoryPath ? '__' + pathParts.join('__') : ''}`.toLowerCase();
        return { gitHubOrg, gitHubRepo, name, repositoryPath, isRemote: false };
      } else {
        // Simple URLs like https://github.com/owner/repo
        const name = `${gitHubOrg}__${gitHubRepo}`.toLowerCase();
        return { gitHubOrg, gitHubRepo, name, repositoryPath: null, isRemote: false };
      }
    } else {
      // This is a remote MCP URL (not GitHub)
      // Extract domain and create a name from it
      const urlObj = new URL(cleanUrl);
      const hostname = urlObj.hostname;

      // Extract the main domain name (remove www, subdomain variations)
      let domain = hostname.replace(/^(www\.|mcp\.|api\.)/, '');
      // Get the main part of the domain (e.g., "huggingface" from "huggingface.co")
      const domainParts = domain.split('.');
      const mainDomain = domainParts[0];

      // Generate consistent name for remote MCPs
      const name = `${mainDomain}__remote-mcp`.toLowerCase();

      return {
        gitHubOrg: mainDomain,
        gitHubRepo: 'remote-mcp',
        name: name,
        repositoryPath: null,
        isRemote: true,
        remoteUrl: cleanUrl,
      };
    }
  } catch (error) {
    console.error(`Error extracting info from URL ${url}:`, error);
    const fallbackName = url.split('/').pop() || 'unknown';
    return {
      gitHubOrg: 'unknown',
      gitHubRepo: fallbackName,
      name: fallbackName,
      repositoryPath: null,
      isRemote: false,
    };
  }
}

// Load servers from mcp-servers.json and merge with evaluations
// If name is provided, returns only that specific server in an array
// If no name is provided, returns all servers
export function loadServers(name?: string): ArchestraMcpServerManifest[] {
  // Clear cache in development mode to ensure fresh data
  if (process.env.NODE_ENV !== 'production') {
    serversCache.clear();
  }

  // Check cache first
  const cacheKey = name || CACHE_KEY_ALL;
  const cached = serversCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const servers: ArchestraMcpServerManifest[] = [];
  const evaluationsMap = new Map<string, ArchestraMcpServerManifest>();
  const processedNames = new Set<string>();

  // If a specific name is requested, try to load just that evaluation file
  if (name) {
    const evaluationPath = path.join(MCP_SERVERS_EVALUATIONS_DIR, `${name}.json`);

    if (fs.existsSync(evaluationPath)) {
      try {
        const content = fs.readFileSync(evaluationPath, 'utf-8');
        const evaluation = JSON.parse(content) as ArchestraMcpServerManifest;
        evaluationsMap.set(evaluation.name, evaluation);
      } catch (error) {
        console.warn(`Failed to load evaluation file for ${name}:`, error);
      }
    }
  } else {
    // Load all evaluations if no specific name is requested
    if (fs.existsSync(MCP_SERVERS_EVALUATIONS_DIR)) {
      try {
        const files = fs.readdirSync(MCP_SERVERS_EVALUATIONS_DIR);

        for (const file of files) {
          if (file.endsWith('.json')) {
            try {
              const filePath = path.join(MCP_SERVERS_EVALUATIONS_DIR, file);
              const content = fs.readFileSync(filePath, 'utf-8');
              const evaluation = JSON.parse(content) as ArchestraMcpServerManifest;
              // Map by name instead of trying to reconstruct URL
              evaluationsMap.set(evaluation.name, evaluation);
            } catch (error) {
              console.warn(`Failed to load evaluation file ${file}:`, error);
            }
          }
        }
      } catch (error) {
        console.error('Failed to load evaluations:', error);
      }
    }
  }

  // Then, load servers from mcp-servers.json
  try {
    const mcpServersContent = fs.readFileSync(MCP_SERVERS_JSON_FILE_PATH, 'utf-8');
    const mcpServerUrls = JSON.parse(mcpServersContent) as string[];

    for (const url of mcpServerUrls) {
      // Extract info to generate name for lookup
      const { gitHubOrg, gitHubRepo, name: urlName, repositoryPath, isRemote, remoteUrl } = extractServerInfo(url);

      // If we're looking for a specific name, skip others
      if (name && urlName !== name) {
        continue;
      }

      // Skip if we've already processed this name (avoid duplicates)
      if (processedNames.has(urlName)) {
        continue;
      }
      processedNames.add(urlName);

      // Check if we have an evaluation for this server using the name
      const evaluation = evaluationsMap.get(urlName);

      if (evaluation) {
        // If this is a remote server and the evaluation doesn't have remote_url, add it
        if (isRemote && remoteUrl && evaluation.server.type === 'remote') {
          evaluation.server.url = remoteUrl;
        }
        servers.push(evaluation);
        // If we found the specific name we're looking for, we can cache and return early
        if (name) {
          serversCache.set(cacheKey, servers);
          return servers;
        }
      } else {
        // Create a placeholder entry for servers without evaluation
        if (isRemote) {
          // For remote MCPs, create a simplified placeholder
          const displayName = gitHubOrg.charAt(0).toUpperCase() + gitHubOrg.slice(1) + ' MCP';

          const server: ArchestraMcpServerManifest = {
            name: urlName,
            display_name: displayName,
            description: `Remote MCP server from ${gitHubOrg}`,
            author: {
              name: gitHubOrg,
            },
            server: {
              type: 'remote',
              url: remoteUrl!,
              docs_url: null,
            },
            archestra_config: {
              client_config_permutations: null,
              oauth: {
                provider: null,
                required: false,
              },
              works_in_archestra: false,
            },
            user_config: {},
            category: null,
            quality_score: null,
            github_info: null,
            programming_language: null,
            protocol_features: {
              implementing_tools: false,
              implementing_prompts: false,
              implementing_resources: false,
              implementing_sampling: false,
              implementing_roots: false,
              implementing_logging: false,
              implementing_stdio: false,
              implementing_streamable_http: true, // Remote servers typically use HTTP streaming
              implementing_oauth2: false,
            },
            readme: null,
            framework: null,
            last_scraped_at: null,
            evaluation_model: null,
            dependencies: [],
            raw_dependencies: null,
          };
          servers.push(server);
        } else {
          // For GitHub servers, keep the existing logic
          const displayName = repositoryPath ? repositoryPath.split('/').pop() || gitHubRepo : gitHubRepo;

          const server: ArchestraMcpServerManifest = {
            name: urlName,
            display_name: displayName,
            description: "We're evaluating this MCP server",
            author: {
              name: gitHubOrg,
            },
            server: {
              type: 'local',
              command: 'unknown',
              args: [],
              env: {},
            },
            archestra_config: {
              client_config_permutations: null,
              oauth: {
                provider: null,
                required: false,
              },
              works_in_archestra: false,
            },
            user_config: {},
            category: null,
            quality_score: null,
            github_info: {
              owner: gitHubOrg,
              repo: gitHubRepo,
              stars: 0,
              contributors: 0,
              issues: 0,
              releases: false,
              ci_cd: false,
              latest_commit_hash: null,
              path: repositoryPath,
              url: url,
              name: urlName,
            },
            programming_language: 'Unknown',
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
            readme: null,
            framework: null,
            last_scraped_at: null,
            evaluation_model: null,
            dependencies: [],
            raw_dependencies: null,
          };
          servers.push(server);
        }
        // If we found the specific name we're looking for, we can cache and return early
        if (name) {
          serversCache.set(cacheKey, servers);
          return servers;
        }
      }
    }
  } catch (error) {
    console.error('Failed to load mcp-servers.json:', error);
  }

  // Sort: evaluated servers first (by trust score), then unevaluated servers
  const sortedServers = servers.sort((a, b) => {
    // Get names for comparison - use display_name for remote servers without github_info
    const nameA = a.github_info
      ? a.github_info.path
        ? a.github_info.path.split('/').pop() || a.github_info.repo
        : a.github_info.repo
      : a.display_name;
    const nameB = b.github_info
      ? b.github_info.path
        ? b.github_info.path.split('/').pop() || b.github_info.repo
        : b.github_info.repo
      : b.display_name;

    // Evaluated servers come first
    if (a.quality_score !== null && b.quality_score === null) return -1;
    if (a.quality_score === null && b.quality_score !== null) return 1;

    // Among evaluated servers, sort by trust score
    if (a.quality_score !== null && b.quality_score !== null) {
      if (a.quality_score !== b.quality_score) {
        return b.quality_score - a.quality_score;
      }
      // Sort by stars if both have github_info, otherwise consider equal
      if (a.github_info && b.github_info) {
        return b.github_info.stars - a.github_info.stars;
      }
      return 0;
    }

    // Among unevaluated servers, sort alphabetically
    return nameA.localeCompare(nameB);
  });

  // Cache the results
  serversCache.set(cacheKey, sortedServers);
  return sortedServers;
}

/**
 * Load only servers from the same repository as the target server
 */
function loadServersFromSameRepo(targetServer: ArchestraMcpServerManifest): ArchestraMcpServerManifest[] {
  // Remote servers don't have repositories, return empty array
  if (!targetServer.github_info) {
    return [];
  }

  const { owner, repo } = targetServer.github_info;
  const cacheKey = `repo_${owner}_${repo}`;

  // Check cache first
  const cached = serversCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const servers: ArchestraMcpServerManifest[] = [];

  // Load mcp-servers.json to find all URLs from the same repo
  try {
    const mcpServersContent = fs.readFileSync(MCP_SERVERS_JSON_FILE_PATH, 'utf-8');
    const mcpServerUrls = JSON.parse(mcpServersContent) as string[];

    for (const url of mcpServerUrls) {
      const { gitHubOrg, gitHubRepo, name: urlName, isRemote } = extractServerInfo(url);

      // Skip remote servers (they don't have repos)
      if (isRemote) {
        continue;
      }

      // Skip if not from the same repo
      if (gitHubOrg !== owner || gitHubRepo !== repo) {
        continue;
      }

      // Try to load the evaluation file for this server
      const evaluationPath = path.join(MCP_SERVERS_EVALUATIONS_DIR, `${urlName}.json`);
      if (fs.existsSync(evaluationPath)) {
        try {
          const content = fs.readFileSync(evaluationPath, 'utf-8');
          const evaluation = JSON.parse(content) as ArchestraMcpServerManifest;
          servers.push(evaluation);
        } catch (error) {
          console.warn(`Failed to load evaluation file for ${urlName}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('Failed to load servers from same repo:', error);
  }

  // Cache and return
  serversCache.set(cacheKey, servers);
  return servers;
}

/**
 * Get related servers from the same category, sorted by quality score
 */
export function getRelatedServers(server: ArchestraMcpServerManifest, limit: number = 6): ArchestraMcpServerManifest[] {
  if (!server.category) return [];

  const allServers = loadServers();
  return allServers
    .filter((s) => s.name !== server.name && s.category === server.category)
    .sort((a, b) => (b.quality_score ?? 0) - (a.quality_score ?? 0))
    .slice(0, limit);
}

/**
 * Count the number of MCP servers in the same repository
 */
export function countServersInRepo(
  targetServer: ArchestraMcpServerManifest,
  allServers?: ArchestraMcpServerManifest[]
): number {
  // Remote servers don't have repositories, return 1
  if (!targetServer.github_info) {
    return 1;
  }

  // If allServers is provided, use it (for backward compatibility)
  if (allServers) {
    const count = allServers.filter(
      (server) =>
        server.github_info &&
        targetServer.github_info &&
        server.github_info.owner === targetServer.github_info.owner &&
        server.github_info.repo === targetServer.github_info.repo
    ).length;
    return Math.max(1, count);
  }

  // Otherwise, load only servers from the same repo (much faster)
  const sameRepoServers = loadServersFromSameRepo(targetServer);
  return Math.max(1, sameRepoServers.length);
}
