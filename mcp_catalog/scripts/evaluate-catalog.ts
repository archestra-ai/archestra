#!/usr/bin/env tsx
import { DxtManifestServerSchema, DxtUserConfigurationOptionSchema } from '@anthropic-ai/dxt';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import z from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { extractServerInfo, loadServers } from '@mcpCatalog/lib/catalog';
import { calculateQualityScore } from '@mcpCatalog/lib/quality-calculator';
import {
  ArchestraClientConfigPermutationsSchema,
  ArchestraMcpServerProtocolFeaturesSchema,
  ArchestraOauthSchema,
  ArchestraSupportedOauthProvidersSchema,
  MCPDependencySchema,
  McpServerCategorySchema,
} from '@mcpCatalog/schemas';
import { ArchestraMcpServerGitHubRepoInfo, ArchestraMcpServerManifest } from '@mcpCatalog/types';

import { MCP_SERVERS_EVALUATIONS_DIR, MCP_SERVERS_JSON_FILE_PATH } from './paths';

const CATEGORIES = McpServerCategorySchema.options;

const CanonicalServerAndUserConfigSchema = z.object({
  /**
   * https://github.com/anthropics/dxt/blob/main/MANIFEST.md#server-configuration
   * https://github.com/anthropics/dxt/blob/v0.2.6/src/schemas.ts#L94
   */
  server: DxtManifestServerSchema,
  /**
   * https://github.com/anthropics/dxt/blob/main/MANIFEST.md#user-configuration
   * https://github.com/anthropics/dxt/blob/v0.2.6/src/schemas.ts#L102-L103
   */
  user_config: z.record(z.string(), DxtUserConfigurationOptionSchema),
});

interface GitHubApiResponse {
  name: string;
  owner_name: string;
  description: string;
  stargazers_count: number;
  total_issues_count: number;
  language: string;
  has_releases: boolean;
  has_workflows: boolean;
  contributors_count: number;
  readme_content?: string;
  latest_commit_hash?: string;
  raw_dependencies?: string;
}

interface EvaluateSingleRepoOptions {
  updateGithub?: boolean;
  updateCategory?: boolean;
  updateArchestraClientConfigPermutations?: boolean;
  updateArchestraOauth?: boolean;
  updateCanonicalServerAndUserConfig?: boolean;
  updateDependencies?: boolean;
  updateProtocol?: boolean;
  updateScore?: boolean;
  updateAll?: boolean;
  force?: boolean;
  model?: string;
  showOutput?: boolean;
}

interface EvaluateAllReposOptions extends EvaluateSingleRepoOptions {
  concurrency?: number;
  limit?: number;
  missingOnly?: boolean;
}

// ============= Helper Methods =============

/**
 * Load existing evaluation from file (returns null if not exists)
 */
function loadMCPServerFromFile(filePath: string): ArchestraMcpServerManifest | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error: any) {
    console.warn(`Failed to parse ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * Save evaluation to file
 */
function saveMCPServerToFile(server: ArchestraMcpServerManifest, filePath: string): void {
  const outputDir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(server, null, 2));
}

/**
 * Parse GitHub URL and extract all necessary information
 */
function parseGitHubUrl(url: string): ArchestraMcpServerGitHubRepoInfo {
  const cleanUrl = url.replace(/\/$/, ''); // Remove trailing slash
  const match = cleanUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);

  if (!match) {
    throw new Error(`Invalid GitHub URL: ${url}`);
  }

  const serverInfo = extractServerInfo(url);

  return {
    owner: match[1],
    repo: match[2],
    url: cleanUrl,
    name: serverInfo.name,
    path: serverInfo.repositoryPath,
  };
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch repository data from GitHub API with retry logic
 *
 * https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#get-a-repository
 * https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#list-repository-contributors
 *
 * NOTE: is the releases, actions, and search API calls correct? Was not able to find any documentation on these:
 * https://docs.github.com/en/rest/repos?apiVersion=2022-11-28
 *
 */
async function fetchRepoData(owner: string, repo: string, repositoryPath: string | null): Promise<GitHubApiResponse> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Archestra-MCP-Evaluator',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Helper for API calls
  const apiCall = async (endpoint: string, returnHeaders = false) => {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      headers,
    });
    if (!response.ok) {
      if (response.status === 403 && response.statusText.includes('rate limit')) {
        throw new Error('RATE_LIMITED');
      }
      if (response.status === 404) {
        throw new Error(`REPO_NOT_FOUND: ${response.status}`);
      }
      throw new Error(`GitHub API error: ${response.status}`);
    }
    const data = await response.json();
    if (returnHeaders) {
      return { data, headers: response.headers };
    }
    return data;
  };

  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      // Fetch all data in parallel
      const [repoData, contributorsResponse, releases, workflows, issuesSearchResponse] = await Promise.all([
        apiCall(`/repos/${owner}/${repo}`).catch((error) => {
          // If the main repo API fails, we can't continue
          throw error;
        }),
        apiCall(`/repos/${owner}/${repo}/contributors?per_page=1&anon=true`, true).catch(() => ({
          data: [],
          headers: new Headers(),
        })),
        apiCall(`/repos/${owner}/${repo}/releases`).catch(() => []),
        apiCall(`/repos/${owner}/${repo}/actions/workflows`).catch(() => ({
          total_count: 0,
        })),
        // Use search API to get total issues count (open + closed)
        // Note: We use + for spaces in the query string, and don't encode : or /
        apiCall(`/search/issues?q=repo:${owner}/${repo}+type:issue&per_page=1`, true).catch(() => ({
          data: { total_count: 0 },
          headers: new Headers(),
        })),
      ]);

      // Extract contributor count from Link header or use array length
      let contributorsCount = 1;
      if (contributorsResponse.headers) {
        const linkHeader = contributorsResponse.headers.get('link');
        if (linkHeader) {
          // Parse the last page number from Link header
          const lastPageMatch = linkHeader.match(/page=(\d+)>; rel="last"/);
          if (lastPageMatch) {
            contributorsCount = parseInt(lastPageMatch[1]);
          } else if (Array.isArray(contributorsResponse.data)) {
            contributorsCount = contributorsResponse.data.length;
          }
        } else if (Array.isArray(contributorsResponse.data)) {
          // If no pagination, use the array length
          contributorsCount = contributorsResponse.data.length;
        }
      }

      // Extract total issues count from search response
      let totalIssuesCount = 0;
      if (
        issuesSearchResponse &&
        issuesSearchResponse.data &&
        typeof issuesSearchResponse.data.total_count === 'number'
      ) {
        totalIssuesCount = issuesSearchResponse.data.total_count;
        console.log(`Found ${totalIssuesCount} total issues for ${owner}/${repo}`);
      } else {
        // Fallback to open_issues_count if search API fails
        console.log(`Search API failed for ${owner}/${repo}, falling back to open_issues_count`);
        totalIssuesCount = repoData.open_issues_count || 0;
      }

      // Check if repository path exists
      if (repositoryPath) {
        try {
          await apiCall(`/repos/${owner}/${repo}/contents/${repositoryPath}`);
        } catch (error) {
          throw new Error(`PATH_NOT_FOUND: ${repositoryPath} does not exist in ${owner}/${repo}`);
        }
      }

      // Fetch README
      let readmeContent = '';
      try {
        const readmeUrl = repositoryPath
          ? `/repos/${owner}/${repo}/contents/${repositoryPath}/README.md`
          : `/repos/${owner}/${repo}/readme`;
        const readme = await apiCall(readmeUrl);
        readmeContent = Buffer.from(readme.content, 'base64').toString('utf-8');
      } catch (error) {
        // Don't fall back to root README if subdirectory README doesn't exist
        console.warn(`No README found at ${repositoryPath ? `${repositoryPath}/README.md` : 'root'}`);
      }

      // Fetch dependency files
      let rawDependencies = '';
      const dependencyFiles = [
        'requirements/requirements.txt',
        'requirements.txt',
        'package.json',
        'go.mod',
        'Cargo.toml',
        'Gemfile',
        'pom.xml',
        'build.gradle',
        'composer.json',
        'Pipfile',
        'poetry.lock',
        'setup.py',
        'pyproject.toml',
      ];

      // Collect ALL dependency files from root and first-level subdirectories
      const collectedDependencyFiles: string[] = [];

      try {
        const contentsUrl = repositoryPath
          ? `/repos/${owner}/${repo}/contents/${repositoryPath}`
          : `/repos/${owner}/${repo}/contents`;

        const contents = await apiCall(contentsUrl);

        // Find dependency files in root directory
        const rootDepFiles = contents
          .filter((item: any) => item.type === 'file' && dependencyFiles.includes(item.name))
          .map((item: any) => item.name);

        // Fetch all dependency files from root
        for (const depFile of rootDepFiles) {
          try {
            const depFileUrl = repositoryPath
              ? `/repos/${owner}/${repo}/contents/${repositoryPath}/${depFile}`
              : `/repos/${owner}/${repo}/contents/${depFile}`;

            const depFileData = await apiCall(depFileUrl);
            const content = Buffer.from(depFileData.content, 'base64').toString('utf-8');
            collectedDependencyFiles.push(`=== ${depFile} ===\n${content}`);
            console.log(`Found dependency file: ${depFile}`);
          } catch (error) {
            // Continue to next file
          }
        }

        // Find subdirectories (first-level only)
        const subdirectories = contents
          .filter((item: any) => item.type === 'dir')
          .filter((item: any) => {
            // Skip common non-source directories
            const skipDirs = [
              'node_modules',
              '.git',
              'vendor',
              'dist',
              'build',
              'out',
              'target',
              '.idea',
              '.vscode',
              '__pycache__',
              'coverage',
              '.pytest_cache',
              '.tox',
              'venv',
              'env',
            ];
            return !skipDirs.includes(item.name);
          });

        // Check each subdirectory for dependency files
        for (const subdir of subdirectories) {
          try {
            const subdirUrl = repositoryPath
              ? `/repos/${owner}/${repo}/contents/${repositoryPath}/${subdir.name}`
              : `/repos/${owner}/${repo}/contents/${subdir.name}`;

            const subdirContents = await apiCall(subdirUrl);

            // Find dependency files in subdirectory
            const subdirDepFiles = subdirContents
              .filter((item: any) => item.type === 'file' && dependencyFiles.includes(item.name))
              .map((item: any) => item.name);

            // Fetch dependency files from subdirectory
            for (const depFile of subdirDepFiles) {
              try {
                const depFileUrl = repositoryPath
                  ? `/repos/${owner}/${repo}/contents/${repositoryPath}/${subdir.name}/${depFile}`
                  : `/repos/${owner}/${repo}/contents/${subdir.name}/${depFile}`;

                const depFileData = await apiCall(depFileUrl);
                const content = Buffer.from(depFileData.content, 'base64').toString('utf-8');
                collectedDependencyFiles.push(`=== ${subdir.name}/${depFile} ===\n${content}`);
                console.log(`Found dependency file: ${subdir.name}/${depFile}`);
              } catch (error) {
                // Continue to next file
              }
            }
          } catch (error) {
            // Continue to next subdirectory
          }
        }

        // Combine all collected dependency files
        if (collectedDependencyFiles.length > 0) {
          rawDependencies = collectedDependencyFiles.join('\n\n');
          console.log(`Collected ${collectedDependencyFiles.length} dependency file(s)`);
        }
      } catch (error) {
        console.warn(`Could not list directory contents`);
      }

      // Fetch latest commit
      let latestCommitHash = '';
      try {
        const commits = await apiCall(`/repos/${owner}/${repo}/commits?per_page=1`);
        if (commits[0]) latestCommitHash = commits[0].sha;
      } catch {}

      return {
        name: repoData.name,
        owner_name: repoData.owner.login,
        description: repoData.description || '',
        stargazers_count: repoData.stargazers_count,
        total_issues_count: totalIssuesCount,
        language: repoData.language || 'Unknown',
        has_releases: Array.isArray(releases) && releases.length > 0,
        has_workflows: workflows.total_count > 0,
        contributors_count: contributorsCount,
        readme_content: readmeContent,
        latest_commit_hash: latestCommitHash,
        raw_dependencies: rawDependencies,
      };
    } catch (error: any) {
      if (error.message === 'RATE_LIMITED' && retryCount < maxRetries) {
        retryCount++;
        const waitTime = Math.min(60000 * retryCount, 180000);
        console.log(`Rate limited. Waiting ${waitTime / 1000}s before retry...`);
        await sleep(waitTime);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Failed after ${maxRetries} retries`);
}

/**
 * Convert JSON Schema to Gemini's schema format
 */
function convertToGeminiSchema(jsonSchema: any): any {
  if (!jsonSchema) return undefined;

  // Handle primitive types
  if (typeof jsonSchema === 'string') {
    return { type: jsonSchema.toUpperCase() };
  }

  // Extract type, handling various formats
  let schemaType = jsonSchema.type;

  // If type is an array (union types), get the first non-null type
  if (Array.isArray(schemaType)) {
    schemaType = schemaType.find((t) => t !== 'null') || schemaType[0];
  }

  // Convert to uppercase if it's a string
  const geminiType = typeof schemaType === 'string' ? schemaType.toUpperCase() : 'OBJECT';

  if (geminiType === 'OBJECT') {
    // Handle objects with additionalProperties (dynamic keys)
    if (jsonSchema.additionalProperties && typeof jsonSchema.additionalProperties === 'object') {
      // For Gemini, we need to provide example properties since it doesn't support dynamic keys
      const additionalSchema = convertToGeminiSchema(jsonSchema.additionalProperties);

      // If this object also has defined properties, include them
      const properties: any = {};
      if (jsonSchema.properties) {
        for (const [key, value] of Object.entries(jsonSchema.properties)) {
          properties[key] = convertToGeminiSchema(value);
        }
      }

      // Add example dynamic properties - these will be replaced with actual server names
      properties['server-basic'] = additionalSchema;
      properties['server-docker'] = additionalSchema;
      properties['server-configured'] = additionalSchema;

      return {
        type: 'OBJECT',
        properties,
        required: jsonSchema.required || [],
      };
    }

    // For objects without defined properties, add minimal schema
    if (!jsonSchema.properties || Object.keys(jsonSchema.properties).length === 0) {
      return {
        type: 'OBJECT',
        properties: {
          _placeholder: { type: 'STRING' },
        },
      };
    }

    // Convert defined properties
    const properties: any = {};
    for (const [key, value] of Object.entries(jsonSchema.properties)) {
      properties[key] = convertToGeminiSchema(value);
    }

    return {
      type: 'OBJECT',
      properties,
      required: jsonSchema.required || [],
    };
  } else if (geminiType === 'ARRAY' && jsonSchema.items) {
    return {
      type: 'ARRAY',
      items: convertToGeminiSchema(jsonSchema.items),
    };
  } else if (geminiType === 'STRING' || geminiType === 'NUMBER' || geminiType === 'BOOLEAN') {
    return { type: geminiType };
  }

  // Default fallback
  return { type: geminiType };
}

/**
 * Call LLM (Ollama or Gemini) for analysis
 */
async function callLLM(prompt: string, format?: any, model = 'gemini-2.5-pro'): Promise<any> {
  // Add retry logic for transient failures
  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        // Wait before retry (exponential backoff)
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.log(`  ⏳ Retrying LLM call (attempt ${attempt}/${maxRetries}) after ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // Check if this is a Gemini model
      if (model.startsWith('gemini-')) {
        // Call Gemini API
        const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
        if (!apiKey) {
          throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY environment variable is required for Gemini models');
        }

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        // Convert format schema to Gemini's response schema format if provided
        let generationConfig: any = {
          temperature: 0.1,
          topP: 0.9,
          candidateCount: 1,
        };

        if (format) {
          generationConfig.responseMimeType = 'application/json';
          // Convert JSON Schema to Gemini's schema format
          const convertedSchema = convertToGeminiSchema(format);
          console.log('Converted schema for Gemini:', JSON.stringify(convertedSchema, null, 2));
          generationConfig.responseSchema = convertedSchema;
        }

        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: prompt,
                  },
                ],
              },
            ],
            generationConfig,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`Gemini API error: ${response.status} - ${JSON.stringify(errorData)}`);
        }

        const data = await response.json();

        // Check for API errors in response
        if (data.error) {
          throw new Error(`Gemini API error: ${data.error.message || JSON.stringify(data.error)}`);
        }

        // Check if candidates array is empty (could indicate content filtering)
        if (!data.candidates || data.candidates.length === 0) {
          console.error('Gemini response has no candidates:', JSON.stringify(data).substring(0, 500));
          throw new Error('Gemini returned no candidates (possible content filtering or rate limit)');
        }

        const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (!responseText) {
          console.error('Gemini response structure:', JSON.stringify(data).substring(0, 500));
          throw new Error('No response text from Gemini');
        }

        // Debug logging
        console.log('Raw Gemini response:', responseText.substring(0, 200) + '...');

        try {
          // Try to extract JSON from the response if it contains extra text
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
          }
          return JSON.parse(responseText);
        } catch (parseError: any) {
          console.error('Failed to parse JSON:', responseText);
          throw new Error(`Invalid JSON response from Gemini: ${parseError.message}`);
        }
      } else {
        // Call Ollama API (existing code)
        const response = await fetch('http://localhost:11434/api/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
            format: format || 'json',
            options: {
              temperature: 0.1,
              top_p: 0.9,
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const responseText = data.response.trim();

        // Debug logging
        console.log('Raw Ollama response:', responseText.substring(0, 200) + '...');

        try {
          // Try to extract JSON from the response if it contains extra text
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
          }
          return JSON.parse(responseText);
        } catch (parseError: any) {
          console.error('Failed to parse JSON:', responseText);
          throw new Error(`Invalid JSON response from Ollama: ${parseError.message}`);
        }
      }
    } catch (error: any) {
      lastError = error;
      console.error(`LLM call attempt ${attempt} failed:`, error.message);

      // If it's not the last attempt, continue to retry
      if (attempt < maxRetries) {
        continue;
      }
    }
  }

  // All retries exhausted, throw the last error
  console.error('All LLM call attempts failed');
  throw lastError;
}

/**
 * Remove URL from mcp-servers.json
 */
function removeFromServerList(url: string): void {
  const servers: string[] = JSON.parse(fs.readFileSync(MCP_SERVERS_JSON_FILE_PATH, 'utf8'));
  const filteredServers = servers.filter((s) => s !== url);

  if (filteredServers.length < servers.length) {
    fs.writeFileSync(MCP_SERVERS_JSON_FILE_PATH, JSON.stringify(filteredServers, null, 2));
    console.log(`❌ Removed invalid server: ${url}`);
  }
}

export function determineMCPServerName({ path, repo }: ArchestraMcpServerGitHubRepoInfo): string {
  if (path) {
    // If there's a repository path, use the last part of it
    const pathParts = path.split('/');
    return pathParts[pathParts.length - 1];
  }
  // Otherwise, use the repository name
  return repo;
}

/**
 * Create MCPServer object from GitHub data
 */
function createNewMCPServer(
  githubInfo: ArchestraMcpServerGitHubRepoInfo,
  apiData: GitHubApiResponse
): ArchestraMcpServerManifest {
  /**
   * NOTE: here we are casting the type to ArchestraMcpServerManifest, because the type is not fully defined yet
   * some of the data will be filled in throughout the various steps of the evaluation process in this script
   */
  return {
    dxt_version: '1.0.0',
    version: '1.0.0',
    name: githubInfo.name.replace(/#/g, '-'), // Sanitize # to - for filesystem compatibility
    display_name: determineMCPServerName(githubInfo),
    description: apiData.description || `MCP server from ${githubInfo.owner}/${githubInfo.repo}`,
    author: {
      name: apiData.owner_name || 'unknown',
    },
    server: null, // will be determined later
    readme: apiData.readme_content || null,
    category: null,
    quality_score: null, // Will be calculated
    programming_language: apiData.language,
    framework: null,
    github_info: {
      ...githubInfo,
      stars: apiData.stargazers_count,
      contributors: apiData.contributors_count,
      issues: apiData.total_issues_count,
      releases: apiData.has_releases,
      ci_cd: apiData.has_workflows,
      latest_commit_hash: apiData.latest_commit_hash || null,
    },
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
    user_config: null, // will be determined later
    archestra_config: null, // will be determined later
    evaluation_model: null,
    raw_dependencies: apiData.raw_dependencies || null,
    last_scraped_at: new Date().toISOString(),
  } as unknown as ArchestraMcpServerManifest;
}

/**
 * Extract GitHub data for an existing server
 */
async function extractGitHubData(
  server: ArchestraMcpServerManifest,
  githubInfo: ArchestraMcpServerGitHubRepoInfo,
  force: boolean = false
): Promise<ArchestraMcpServerManifest> {
  // Skip if already exists and not forcing
  if (server.last_scraped_at && !force) {
    console.log(`  ⏭️  GitHub Data: Skipped (last scraped: ${server.last_scraped_at})`);
    return server;
  }
  console.log(`  🔄 GitHub Data: Fetching...`);

  const { owner, repo, path } = githubInfo;

  const apiData = await fetchRepoData(owner, repo, path);
  const newServer = createNewMCPServer(githubInfo, apiData);

  // Merge GitHub fields
  return {
    ...server,
    name: newServer.name,
    description: newServer.description,
    readme: newServer.readme,
    programming_language: newServer.programming_language,
    github_info: newServer.github_info,
    last_scraped_at: newServer.last_scraped_at,
    raw_dependencies: newServer.raw_dependencies,
  };
}

// ============= Core Extraction Methods =============

/**
 * Extract category classification using AI
 */
async function extractCategory(
  server: ArchestraMcpServerManifest,
  model: string,
  force: boolean = false
): Promise<ArchestraMcpServerManifest> {
  // Skip if human evaluation (evaluation_model === null AND category already exists)
  if (server.evaluation_model === null && server.category && !force) {
    console.log(`  ⏭️  Category: Skipped (human evaluation)`);
    return server;
  }
  // Skip if already exists and not forcing
  if (server.category && !force) {
    console.log(`  ⏭️  Category: Skipped (already exists: "${server.category}")`);
    return server;
  }
  console.log(`  🔄 Category: Extracting...`);

  const content = server.readme || server.description;
  if (!content) {
    console.warn('No content available for category analysis');
    return server;
  }

  const prompt = `Analyze this MCP server and choose the most appropriate category from this list: ${CATEGORIES.join(
    ', '
  )}

Content:
${content.substring(0, 8000)}

Respond with JSON: {"category": "..."}`;

  try {
    const result = await callLLM(prompt, null, model);
    if (result.category) {
      return {
        ...server,
        category: result.category as any,
        evaluation_model: model,
      };
    }
  } catch (error: any) {
    console.warn(`Category analysis failed: ${error.message}`);
  }

  return server;
}

/**
 * Extract Archestra specific, "client configuration permutations", using AI
 */
async function extractArchestraClientConfigPermutationsConfig(
  server: ArchestraMcpServerManifest,
  model: string,
  force: boolean = false
): Promise<ArchestraMcpServerManifest> {
  // Skip if human evaluation (evaluation_model === null AND server config already exists)
  if (server.evaluation_model === null && server.server && !force) {
    console.log(`  ⏭️  Server Config: Skipped (human evaluation)`);
    return server;
  }
  // Skip if already exists and not forcing
  // Check if client_config_permutations exists AND has actual server configurations
  if (
    server.archestra_config?.client_config_permutations?.mcpServers &&
    Object.keys(server.archestra_config.client_config_permutations.mcpServers).length > 0 &&
    !force
  ) {
    console.log(`  ⏭️  Server Config: Skipped (already exists)`);
    return server;
  }
  console.log(`  🔄 Server Config: Extracting...`);

  const content = server.readme || server.description;
  if (!content) {
    console.warn('No content available for server config analysis');
    return server;
  }

  const prompt = `Find the run configuration for this MCP server. Look for commands that START the server.

Content:
${content.substring(0, 8000)}

Instructions:
- Extract all ways to run the server (npx, docker, node, python, etc.)
- For Docker commands: split "docker run" into command="docker" and args=["run", ...]
- For npx: command="npx", args=["-y", "package-name"]
- Extract environment variables from docker -e flags to env object
- CRITICAL: Server names MUST be derived from the actual package/image names in the content:
  - Look for the EXACT package name in the content
  - For scoped npm packages: "@scope/package-name" → "scope-package-name"
  - For docker images: extract the image name and append "-docker"
  - For Python packages in uvx/pip: use the exact package name
  - Transform rules:
    * Replace @ with nothing
    * Replace / with hyphen
    * Keep the full package name, don't shorten it
    * Don't use just the last part of the name
  - Add suffixes for variants: "-docker", "-configured", "-stdio", "-with-config"
  - NEVER use generic names like "server-basic", "server-configured", "server-docker"
  - NEVER use single-word names like "agent", "server", "mcp"

CRITICAL FOR ENVIRONMENT VARIABLES:
- Extract ALL environment variables that appear in the README
- Look for environment variables in:
  * Tables with columns like "Variable", "Environment Variable", "Env Var", etc.
  * Code blocks showing export commands or .env files
  * Installation/configuration documentation sections
  * Environment variable reference sections
- Include EVERY SINGLE environment variable mentioned
- DO NOT rename or transform environment variable names
- Examples:
  * If README shows "SLACK_MCP_XOXC_TOKEN", use exactly "SLACK_MCP_XOXC_TOKEN"
  * If README shows "OPENAI_API_KEY", use exactly "OPENAI_API_KEY"
- IMPORTANT: If you see a table of environment variables, include ALL of them

Important:
- For Docker, include the full image name in args
- Environment vars from -e flags go in both args and env
- Create separate entries for different configurations of the same server
- DON'T PLACE ENV VARS AS NULL, USE A PLACEHOLDER STRING LIKE "<YOUR_API_KEY_HERE>"

Examples of CORRECT output:

If you find "mcp-server-fetch" in uvx command:
{
  "mcpServers": {
    "mcp-server-fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"]
    }
  }
}

If you find "@modelcontextprotocol/server-filesystem" in npx and a docker variant:
{
  "mcpServers": {
    "filesystem-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/files"]
    },
    "filesystem-server-docker": {
      "command": "docker",
      "args": ["run", "-v", "/path:/data", "mcp/filesystem:latest"]
    }
  }
}

The keys MUST be based on the actual package/image names found in the content.

If no run command found, respond with: {"mcpServers": {}}`;

  // For Gemini, we need a simpler schema without additionalProperties
  const isGemini = model.startsWith('gemini-');
  const configFormat = isGemini ? undefined : zodToJsonSchema(ArchestraClientConfigPermutationsSchema);

  try {
    const result = await callLLM(prompt, configFormat, model);
    // Only save if mcpServers exists AND has actual content
    if (result.mcpServers && Object.keys(result.mcpServers).length > 0) {
      return {
        ...server,
        archestra_config: {
          ...server.archestra_config,
          client_config_permutations: result,
        },
        evaluation_model: model,
      };
    } else {
      console.log(`  ⚠️  Server Config: No configurations found in README`);
    }
  } catch (error: any) {
    console.warn(`Server config analysis failed: ${error.message}`);
  }

  return server;
}

/**
 * Extract the canonical server, and user config, configurations using AI
 *
 * Information in prompt was built using information from the following resources:
 * https://github.com/anthropics/dxt/blob/v0.2.6/src/schemas.ts#L29
 * https://github.com/anthropics/dxt/blob/main/MANIFEST.md#server-configuration
 * https://github.com/anthropics/dxt/blob/main/MANIFEST.md#user-configuration
 */
async function extractCanonicalServerAndUserConfigConfig(
  server: ArchestraMcpServerManifest,
  model: string,
  force: boolean = false
): Promise<ArchestraMcpServerManifest> {
  // Skip if human evaluation (evaluation_model === null AND configs already exist)
  if (server.evaluation_model === null && server.server && server.user_config && !force) {
    console.log(`  ⏭️  Canonical Server and User Config: Skipped (human evaluation)`);
    return server;
  }

  // Skip if already exists and not forcing
  if (server?.server && server?.user_config && !force) {
    console.log(`  ⏭️  Canonical Server and User Config: Skipped (already exists)`);
    return server;
  }
  console.log(`  🔄 Canonical Server and User Config: Extracting...`);

  const content = server.readme || server.description;
  if (!content) {
    console.warn('No content available for canonical server and user config analysis');
    return server;
  }

  const prompt = `Extract the canonical server and user config configurations for this MCP server.

Content:
${content.substring(0, 8000)}

IMPORTANT: You MUST return a JSON object with BOTH "server" and "user_config" fields. The "server" object MUST include:
1. "type": REQUIRED - Must be either "python", "node", "binary" or "docker"
2. "entry_point": REQUIRED - The main file to execute (e.g., "index.js", "main.py", or binary name)
3. "mcp_config": REQUIRED - Object with "command", "args", and "env" fields

Instructions:
- Determine the server type based on the runtime:
  * If it uses npx, npm, node, or has package.json → type="node", entry_point="index.js" (or main file)
  * If it uses python, pip, or has requirements.txt → type="python", entry_point="main.py" (or main file)  
  * If it's a compiled executable → type="binary", entry_point=<binary name>
- Extract the CANONICAL way to run this server. Use a docker command as the LAST resort. Have a preference towards npx, node, python, etc.
- Additionally, for any dynamic configuration (e.g. flags, environment variables, api keys, etc.) this should go into the "user_config" object (using the format documented below)
- For Docker commands: split "docker run" into command="docker" and args=["run", ...]
- For npx: command="npx", args=["-y", "package-name"], type="node", entry_point="index.js"
- Extract environment variables from docker -e flags to env object
- For Docker, include the full image name in args
- Environment vars from -e flags go in both args and env

CRITICAL FOR ENVIRONMENT VARIABLES:
- You MUST extract ALL environment variables that appear in the README
- Look for environment variables in:
  * Tables with columns like "Variable", "Environment Variable", "Env Var", etc.
  * Code blocks showing export commands or .env files
  * Installation/configuration documentation sections
  * Environment variable reference sections
- Extract EVERY SINGLE environment variable mentioned, including:
  * Authentication tokens (API keys, OAuth tokens, etc.)
  * Configuration settings (ports, hosts, URLs)
  * Feature flags (enable/disable features)
  * File paths (cache files, certificates, etc.)
  * Logging and debug settings
- DO NOT rename or transform environment variable names
- Include ALL env vars in the server.mcp_config.env section
- For each env var, create a corresponding user_config entry
- Examples:
  * If README shows "SLACK_MCP_XOXC_TOKEN", use exactly "SLACK_MCP_XOXC_TOKEN" (not SLACK_APP_TOKEN)
  * If README shows "OPENAI_API_KEY", use exactly "OPENAI_API_KEY" (not API_KEY)
- For the user_config keys, use lowercase with underscores version of the env var name
  * SLACK_MCP_XOXC_TOKEN → slack_mcp_xoxc_token
  * SLACK_MCP_PORT → slack_mcp_port
  * OPENAI_API_KEY → openai_api_key
- IMPORTANT: If you see a table of environment variables, include EVERY SINGLE ONE in the configuration

More specific information about the data that you are extracting:

Server Configuration

The server object defines how to run the MCP server:

Server Types

1. **Python**: server.type = "python"
   - Requires entry_point to Python file
   - All dependencies must be bundled in the DXT
   - Can use server/lib for packages or server/venv for full virtual environment
   - Python runtime version specified in compatibility.runtimes.python

2. **Node.js**: server.type = "node"
   - Requires entry_point to JavaScript file
   - All dependencies must be bundled in node_modules
   - Node.js runtime version specified in compatibility.runtimes.node
   - Typically includes package.json at extension root for dependency management

3. **Binary**: server.type = "binary"
   - Pre-compiled executable with all dependencies included
   - Platform-specific binaries supported
   - Completely self-contained (no runtime requirements)

MCP Configuration

The mcp_config object in the server configuration defines how the implementing app should execute the MCP server. This replaces the manual JSON configuration users currently need to write.

**Python Example:**

"mcp_config": {
  "command": "python",
  "args": ["server/main.py"],
  "env": {
    "PYTHONPATH": "server/lib"
  }
}

**Node.js Example:**

"mcp_config": {
  "command": "node",
  "args": ["$\{__dirname\}/server/index.js"],
  "env": {}
}

**Binary Example:**

"mcp_config": {
  "command": "server/my-server",
  "args": ["--config", "server/config.json"],
  "env": {}
}

**Variable Substitution:**
These pertain to any configuration that is "dynamic" and needs to be substituted with actual user-inputted values at runtime:

- **$\{__dirname\}**: This variable is replaced with the absolute path to the extension's directory. This is useful for referencing files within the extension package.
- **$\{HOME\}**: User's home directory
- **$\{DESKTOP\}**: User's desktop directory
- **$\{DOCUMENTS\}**: User's documents directory
- **$\{DOWNLOADS\}**: User's downloads directory

Example:

"mcp_config": {
  "command": "python",
  "args": ["$\{__dirname\}/server/main.py"],
  "env": {
    "CONFIG_PATH": "$\{__dirname\}/config/settings.json"
  }
}

This ensures that paths work correctly regardless of where the extension is installed on the user's system.

- **$\{user_config\}**: Your extension can specify user-configured values that the implementing app will collect from users. Read on to learn more about user configuration.

User Configuration

The user_config field allows extension developers to specify configuration options that can be presented to end users through the implementing app's user interface. These configurations are collected from users and passed to the MCP server at runtime.

Configuration Schema

Each configuration option is defined as a key-value pair where the key is the configuration name and the value is an object with these properties:

- **type**: The data type of the configuration
  - "string": Text input
  - "number": Numeric input
  - "boolean": Checkbox/toggle
  - "directory": Directory picker
  - "file": File picker
- **title**: Display name shown in the UI
- **description**: Help text explaining the configuration option
- **required**: Whether this field must be provided (default: false)
- **default**: Default value (supports variable substitution)
- **multiple**: For directory/file types, allow multiple selections (default: false)
- **sensitive**: For string types, mask input and store securely (default: false)
- **min/max**: For number types, validation constraints

### Variable Substitution in User Configuration

User configuration values support variable substitution in mcp_config:

- **$\{user_config.KEY\}**: Replaced with the user-provided value for configuration KEY
- Arrays (from multiple selections) are expanded as separate arguments
- Environment variables are ideal for sensitive data
- Command arguments work well for paths and non-sensitive options

Available variables for default values:

- **$\{HOME\}**: User's home directory
- **$\{DESKTOP\}**: User's desktop directory
- **$\{DOCUMENTS\}**: User's documents directory

### Examples

**Filesystem Extension with Directory Configuration:**

{
  "user_config": {
    "allowed_directories": {
      "type": "directory",
      "title": "Allowed Directories",
      "description": "Select directories the filesystem server can access",
      "multiple": true,
      "required": true,
      "default": ["$\{HOME\}/Desktop", "$\{HOME\}/Documents"]
    }
  },
  "server": {
    "mcp_config": {
      "command": "node",
      "args": [
        "$\{__dirname\}/server/index.js",
        "$\{user_config.allowed_directories\}"
      ]
    }
  }
}

**API Integration with Authentication:**

{
  "user_config": {
    "api_key": {
      "type": "string",
      "title": "API Key",
      "description": "Your API key for authentication",
      "sensitive": true,
      "required": true
    },
    "base_url": {
      "type": "string",
      "title": "API Base URL",
      "description": "The base URL for API requests",
      "default": "https://api.example.com",
      "required": false
    }
  },
  "server": {
    "mcp_config": {
      "command": "node",
      "args": ["server/index.js"],
      "env": {
        "API_KEY": "$\{user_config.api_key\}",
        "BASE_URL": "$\{user_config.base_url\}"
      }
    }
  }
}

**Database Connection Configuration:**

{
  "user_config": {
    "database_path": {
      "type": "file",
      "title": "Database File",
      "description": "Path to your SQLite database file",
      "required": true
    },
    "read_only": {
      "type": "boolean",
      "title": "Read Only Mode",
      "description": "Open database in read-only mode",
      "default": true
    },
    "timeout": {
      "type": "number",
      "title": "Query Timeout (seconds)",
      "description": "Maximum time for query execution",
      "default": 30,
      "min": 1,
      "max": 300
    }
  },
  "server": {
    "mcp_config": {
      "command": "python",
      "args": [
        "server/main.py",
        "--database",
        "$\{user_config.database_path\}",
        "--timeout",
        "$\{user_config.timeout\}"
      ],
      "env": {
        "READ_ONLY": "$\{user_config.read_only\}"
      }
    }
  }
}

### Implementation Notes

- **Array Expansion**: When a configuration with multiple: true is used in args, each value is expanded as a separate argument. For example, if the user selects directories /home/user/docs and /home/user/projects, the args ["$\{user_config.allowed_directories\}"] becomes ["/home/user/docs", "/home/user/projects"]

EXAMPLE RESPONSE for an npx-based MCP server:
{
  "server": {
    "type": "node",
    "entry_point": "index.js",
    "mcp_config": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": {}
    }
  },
  "user_config": {}
}

EXAMPLE RESPONSE for a server with environment variables:
{
  "server": {
    "type": "binary",
    "entry_point": "slack-mcp-server",
    "mcp_config": {
      "command": "./slack-mcp-server",
      "args": [],
      "env": {
        "SLACK_MCP_XOXC_TOKEN": "$\{user_config.slack_mcp_xoxc_token\}",
        "SLACK_MCP_XOXD_TOKEN": "$\{user_config.slack_mcp_xoxd_token\}"
      }
    }
  },
  "user_config": {
    "slack_mcp_xoxc_token": {
      "type": "string",
      "title": "Slack Browser Token",
      "description": "Slack browser token (xoxc-...)",
      "sensitive": true,
      "required": false
    },
    "slack_mcp_xoxd_token": {
      "type": "string",
      "title": "Slack Browser Cookie 'd'",
      "description": "Slack browser cookie 'd' (xoxd-...)",
      "sensitive": true,
      "required": false
    }
  }
}

REMEMBER: 
1. The "server" object MUST ALWAYS include "type", "entry_point", and "mcp_config" fields. Never omit these required fields.
2. Use the EXACT environment variable names from the README (don't rename them).
3. For user_config keys, use lowercase with underscores version of the env var name.`;

  // For Gemini, we need a simpler schema without additionalProperties
  const isGemini = model.startsWith('gemini-');
  const configFormat = isGemini ? undefined : zodToJsonSchema(CanonicalServerAndUserConfigSchema);

  try {
    const result = await callLLM(prompt, configFormat, model);
    if (result && result.server) {
      // Validate that server has required fields
      if (!result.server.type || !result.server.entry_point || !result.server.mcp_config) {
        console.warn(
          `Server config missing required fields: type=${result.server.type}, entry_point=${result.server.entry_point}, mcp_config=${!!result.server.mcp_config}`
        );
        // If critical fields are missing, log the issue but still use what we got
        // The improved prompt should prevent this from happening
      }

      return {
        ...server,
        server: result.server,
        user_config: result.user_config || {},
        evaluation_model: model,
      };
    }
  } catch (error: any) {
    console.warn(`Server config analysis failed: ${error.message}`);
  }

  return server;
}

/**
 * Extract Archestra oauth-related configuration using AI
 */
async function extractArchestraOauthConfig(
  server: ArchestraMcpServerManifest,
  model: string,
  force: boolean = false
): Promise<ArchestraMcpServerManifest> {
  // Skip if human evaluation (evaluation_model === null AND archestra_config already exists)
  if (server.evaluation_model === null && server.archestra_config && !force) {
    console.log(`  ⏭️  Archestra OAuth Config: Skipped (human evaluation)`);
    return server;
  }
  // Skip if already exists and not forcing
  if (server.archestra_config?.oauth && !force) {
    console.log(`  ⏭️  Archestra OAuth Config: Skipped (already exists)`);
    return server;
  }
  console.log(`  🔄 Archestra OAuth Config: Extracting...`);

  const content = server.readme || server.description;
  if (!content) {
    console.warn('No content available for Archestra OAuth config analysis');
    return server;
  }

  const prompt = `Determine whether or not oauth setup is needed to configure this MCP server, before being able to run it, in Archestra cloud.

Content:
${content.substring(0, 8000)}

Look for:
- OAuth mentions: "OAuth", "OAuth2", "OAuth 2.0", authentication providers, "Create OAuth 2.0 Credentials", "OAuth client ID"

Respond with JSON format:
{
  "oauth": {
    "provider": "${ArchestraSupportedOauthProvidersSchema.options.join('|')}" | null,
    "required": true | false
  }
}

Rules:
- Set oauth.provider to null if no OAuth/authentication provider is mentioned
- IMPORTANT: Look for OAuth setup instructions, credential creation steps, or authentication flows as indicators
- VERY IMPORTANT!!!!: For right now, the only supported OAuth providers are ${ArchestraSupportedOauthProvidersSchema.options.join(', ')}. If you find an OAuth provider that is not in the list, respond with null for the provider (and false for required).
- If the README mentions creating OAuth credentials, obtaining client IDs, or authentication setup, determine the provider from context

If no configuration found, respond: {"oauth": { "provider": null, "required": false }}`;

  const configFormat = zodToJsonSchema(ArchestraOauthSchema);

  try {
    const result = await callLLM(prompt, configFormat, model);
    if (result.oauth) {
      return {
        ...server,
        archestra_config: {
          ...server.archestra_config,
          oauth: result.oauth,
        },
        evaluation_model: model,
      };
    }
  } catch (error: any) {
    console.warn(`Archestra config analysis failed: ${error.message}`);
  }

  return server;
}

/**
 * Extract dependencies using AI
 */
async function extractDependencies(
  server: ArchestraMcpServerManifest,
  model: string,
  force: boolean = false
): Promise<ArchestraMcpServerManifest> {
  // Skip if human evaluation (evaluation_model === null AND dependencies already exist)
  if (server.evaluation_model === null && server.dependencies && server.dependencies.length > 0 && !force) {
    console.log(`  ⏭️  Dependencies: Skipped (human evaluation)`);
    return server;
  }
  // Skip if already exists and not forcing
  if (server.dependencies && server.dependencies.length > 0 && !force) {
    console.log(`  ⏭️  Dependencies: Skipped (already exists - ${server.dependencies.length} deps)`);
    return server;
  }
  console.log(`  🔄 Dependencies: Extracting...`);

  const content = server.readme || server.description;
  const rawDeps = server.raw_dependencies;

  if (!content && !rawDeps) {
    console.warn('No content available for dependencies analysis');
    return server;
  }

  const prompt = `Analyze this MCP server and identify its library dependencies.

${rawDeps ? `Dependency File Content:\n${rawDeps}\n` : ''}

README/Description:
${content ? content.substring(0, 8000) : 'Not available'}

Instructions:
1. If dependency file is provided (package.json, requirements.txt, etc.), extract dependencies from it FIRST
2. For package.json, look at "dependencies" object (ignore "devDependencies")
3. For requirements.txt, list each package
4. For go.mod, list the required modules
5. For other formats, extract the production dependencies

IMPORTANT - Clean up dependency names:
- Remove "github.com/" prefix from Go modules (e.g., "github.com/mark3labs/mcp-go" → "mark3labs/mcp-go")
- Remove version constraints (e.g., "express@^5.0.0" → "express")
- Use the package name only, not the full URL or path
- Keep scoped npm packages as-is (e.g., "@modelcontextprotocol/sdk")

Look for these types of libraries:
1. Main framework/library (e.g., Express, FastAPI, Hono, Gin, etc.)
2. MCP-specific libraries (e.g., @modelcontextprotocol/sdk, mcp, fastmcp)
3. Database libraries (e.g., mongoose, prisma, sqlalchemy)
4. API client libraries (e.g., axios, octokit, googleapis)
5. Authentication libraries (e.g., passport, oauth2-client)
6. Utility libraries (e.g., lodash, zod, joi)
7. Testing libraries (only if in production dependencies)
8. Build/bundling tools as libraries (only if required at runtime)

DO NOT include:
- Programming languages (Node.js, Python, Go, etc.)
- Runtime environments
- Package managers (npm, pip, cargo)
- Operating systems
- External services (unless it's a client library for that service)

Respond with JSON format:
{
  "dependencies": [
    {"name": "@modelcontextprotocol/sdk", "importance": 10},
    {"name": "express", "importance": 8},
    {"name": "mark3labs/mcp-go", "importance": 9},
    {"name": "axios", "importance": 6}
  ]
}

Note: For Go modules, use "owner/repo" format WITHOUT "github.com/" prefix

Importance scale (1-10):
- 10: Main framework or core MCP library
- 8-9: Essential libraries for core functionality
- 5-7: Important for specific features
- 3-4: Utility libraries
- 1-2: Optional or dev dependencies

If no library dependencies found, respond: {"dependencies": []}`;

  // Create a schema for the expected response format with dependencies array
  const DependenciesResponseSchema = z.object({
    dependencies: z.array(MCPDependencySchema),
  });
  const dependenciesFormat = zodToJsonSchema(DependenciesResponseSchema);

  try {
    const result = await callLLM(prompt, dependenciesFormat, model);
    if (result.dependencies && result.dependencies.length > 0) {
      return {
        ...server,
        dependencies: result.dependencies,
        evaluation_model: model,
      };
    }
  } catch (error: any) {
    console.warn(`Dependencies analysis failed: ${error.message}`);
  }

  return server;
}

/**
 * Extract protocol features using AI
 */
async function extractProtocolFeatures(
  server: ArchestraMcpServerManifest,
  model: string,
  force: boolean = false
): Promise<ArchestraMcpServerManifest> {
  // Skip if human evaluation (evaluation_model === null AND protocol features already evaluated)
  // Check if at least one protocol feature is true (indicating it's been evaluated)
  const hasProtocolFeatures = Object.values(server.protocol_features || {}).some((v) => v === true);
  if (server.evaluation_model === null && hasProtocolFeatures && !force) {
    console.log(`  ⏭️  Protocol Features: Skipped (human evaluation)`);
    return server;
  }
  // Skip if already exists and not forcing
  // Check if protocol features have been evaluated (implementing_tools will be boolean if evaluated)
  if (server.protocol_features?.implementing_tools !== undefined && !force) {
    console.log(`  ⏭️  Protocol Features: Skipped (already exists)`);
    return server;
  }
  console.log(`  🔄 Protocol Features: Extracting...`);

  const content = server.readme || server.description;
  if (!content) {
    console.warn('No content available for protocol analysis');
    return server;
  }

  const prompt = `Analyze this MCP server README and code to determine which MCP protocol features are implemented.

Content:
${content.substring(0, 8000)}

Look for these MCP protocol features:
1. **Tools** - Server provides tools/functions that can be called (look for "tools", "functions", "methods", tool definitions)
2. **Prompts** - Server provides prompt templates (look for "prompts", "templates", prompt definitions)
3. **Resources** - Server provides resources that can be read (look for "resources", resource definitions, data access)
4. **Sampling** - Server supports completion/sampling requests (look for "sampling", "completion", LLM integration)
5. **Roots** - Server supports roots protocol for directory access (look for "roots", "directories", dynamic directory configuration)
6. **Logging** - Server implements logging features (look for "logging", "log levels", structured logging)
7. **STDIO Transport** - Server supports stdio transport (look for "stdio", command-line interface, standard input/output)
8. **HTTP Transport** - Server supports HTTP/SSE transport (look for "http", "sse", "server-sent events", web server)
9. **OAuth2** - Server implements OAuth2 authentication (look for "oauth", "oauth2", "authentication", "authorization")

Instructions:
- Return true if the feature is clearly implemented based on the README
- Return false if the feature is not mentioned or not implemented
- Look for explicit mentions, code examples, configuration options, or API documentation
- For transports, check if the server mentions how to connect (stdio vs http)
- For OAuth2, look for authentication setup instructions

Respond with JSON format:
{
  "implementing_tools": true/false,
  "implementing_prompts": true/false,
  "implementing_resources": true/false,
  "implementing_sampling": true/false,
  "implementing_roots": true/false,
  "implementing_logging": true/false,
  "implementing_stdio": true/false,
  "implementing_streamable_http": true/false,
  "implementing_oauth2": true/false
}`;

  const protocolFormat = zodToJsonSchema(ArchestraMcpServerProtocolFeaturesSchema);

  try {
    const result = await callLLM(prompt, protocolFormat, model);

    // Update all protocol fields
    // The result IS the protocol features object directly
    return {
      ...server,
      protocol_features: result,
      evaluation_model: model,
    };
  } catch (error: any) {
    console.warn(`Protocol analysis failed: ${error.message}`);
  }

  return server;
}

/**
 * Extract/calculate trust score
 */
async function extractScore(
  server: ArchestraMcpServerManifest,
  force: boolean = false
): Promise<ArchestraMcpServerManifest> {
  // Note: Trust score can be recalculated even for human evaluations
  // Skip if already exists and not forcing
  if (server.quality_score !== null && !force) {
    console.log(`  ⏭️  Trust Score: Skipped (already exists: ${server.quality_score}/100)`);
    return server;
  }
  console.log(`  🔄 Trust Score: Calculating...`);

  // Load all servers for dependency commonality calculation
  const allServers = loadServers();
  const scoreBreakdown = calculateQualityScore(server, allServers);

  return {
    ...server,
    quality_score: scoreBreakdown.total,
  };
}

// ============= Main Functions =============

/**
 * Evaluate a single repository
 */
async function evaluateSingleRepo(
  githubUrl: string,
  {
    showOutput = false,
    force = false,
    updateGithub = false,
    updateCategory = false,
    updateArchestraClientConfigPermutations = false,
    updateArchestraOauth = false,
    updateCanonicalServerAndUserConfig = false,
    updateDependencies = false,
    updateProtocol = false,
    updateScore = false,
    model = 'gemini-2.5-pro',
    updateAll = false,
  }: EvaluateSingleRepoOptions = {}
): Promise<ArchestraMcpServerManifest> {
  try {
    if (showOutput) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔍 Evaluating: ${githubUrl}`);
      console.log(`${'='.repeat(60)}`);
    }

    // 1. Parse GitHub URL
    const githubInfo = parseGitHubUrl(githubUrl);
    const { owner, repo, path: repoPath } = githubInfo;

    // Sanitize the name by replacing # with - for filesystem compatibility
    const sanitizedName = githubInfo.name.replace(/#/g, '-');
    const fileName = `${sanitizedName}.json`;
    const filePath = path.join(MCP_SERVERS_EVALUATIONS_DIR, fileName);

    // 2. Load existing or fetch new data
    let server = loadMCPServerFromFile(filePath);

    if (showOutput) {
      if (server) {
        console.log(`📄 Existing evaluation found: ${fileName}`);
      } else {
        console.log(`🆕 Creating new evaluation for: ${fileName}`);
      }

      console.log(`\n📋 Update Options:`);
      console.log(`  - Force: ${force ? 'YES' : 'NO'}`);
      console.log(`  - Model: ${model || 'gemini-2.5-pro'}`);

      if (updateAll) {
        console.log(`  - Mode: UPDATE ALL`);
      } else {
        const updates = [];
        if (updateGithub) updates.push('GitHub');
        if (updateCategory) updates.push('Category');
        if (updateArchestraClientConfigPermutations) updates.push('Archestra Client Config Permutations');
        if (updateArchestraOauth) updates.push('Archestra Oauth');
        if (updateCanonicalServerAndUserConfig) updates.push('Canonical Server and User Config');
        if (updateDependencies) updates.push('Dependencies');
        if (updateProtocol) updates.push('Protocol');
        if (updateScore) updates.push('Score');
        console.log(`  - Updates: ${updates.length > 0 ? updates.join(', ') : 'Fill missing only'}`);
      }
      console.log(`\n🚀 Processing:`);
    }

    if (!server) {
      // Create new server from GitHub
      const apiData = await fetchRepoData(owner, repo, repoPath);
      server = createNewMCPServer(githubInfo, apiData);
    }

    // 3. Apply updates based on options
    // Determine if any specific update was requested
    const hasSpecificUpdates =
      updateGithub ||
      updateCategory ||
      updateArchestraClientConfigPermutations ||
      updateArchestraOauth ||
      updateCanonicalServerAndUserConfig ||
      updateDependencies ||
      updateProtocol ||
      updateScore;

    // If force is true and specific updates are requested, ONLY do those updates
    // Otherwise, fill in missing data
    const shouldUpdateMissing = !force || !hasSpecificUpdates;

    if (updateGithub || (shouldUpdateMissing && !server.last_scraped_at)) {
      server = await extractGitHubData(server, githubInfo, force);
    }

    if (updateCategory || (shouldUpdateMissing && !server.category)) {
      server = await extractCategory(server, model, force);
    }

    if (
      updateArchestraClientConfigPermutations ||
      (shouldUpdateMissing &&
        (!server.archestra_config?.client_config_permutations?.mcpServers ||
          Object.keys(server.archestra_config?.client_config_permutations?.mcpServers || {}).length === 0))
    ) {
      server = await extractArchestraClientConfigPermutationsConfig(server, model, force);
    }

    if (updateArchestraOauth || (shouldUpdateMissing && !server.archestra_config?.oauth)) {
      server = await extractArchestraOauthConfig(server, model, force);
    }

    if (updateCanonicalServerAndUserConfig || (shouldUpdateMissing && (!server.server || !server.user_config))) {
      server = await extractCanonicalServerAndUserConfigConfig(server, model, force);
    }

    if (updateDependencies || (shouldUpdateMissing && (!server.dependencies || server.dependencies.length === 0))) {
      server = await extractDependencies(server, model, force);
    }

    if (updateProtocol || (shouldUpdateMissing && server.protocol_features?.implementing_tools === undefined)) {
      server = await extractProtocolFeatures(server, model, force);
    }

    if (updateScore || (shouldUpdateMissing && (server.quality_score === null || server.quality_score === undefined))) {
      server = await extractScore(server, force);
    }

    // Display results if showOutput
    if (showOutput && server.quality_score !== null) {
      const allServers = loadServers();
      const { mcp_protocol, github_metrics, deployment_maturity, documentation, badge_usage, dependencies, total } =
        calculateQualityScore(server, allServers);

      console.log('\n📈 Trust Score Breakdown:');
      console.log(`  MCP Protocol Implementation: ${mcp_protocol}/40`);
      console.log(`  GitHub Community Health: ${github_metrics}/20`);
      console.log(`  Dependency Optimization: ${dependencies}/20`);
      console.log(`  Deployment Maturity: ${deployment_maturity}/10`);
      console.log(`  Documentation Quality: ${documentation}/8`);
      console.log(`  Badge Adoption: ${badge_usage}/2`);
      console.log(`  📊 Total Score: ${total}/100`);

      if (
        server.category ||
        server.archestra_config ||
        server.user_config ||
        server.server ||
        server.dependencies ||
        server.protocol_features?.implementing_tools !== null
      ) {
        const {
          category,
          server: server_config,
          archestra_config,
          user_config,
          protocol_features: {
            implementing_tools,
            implementing_prompts,
            implementing_resources,
            implementing_sampling,
            implementing_roots,
            implementing_logging,
            implementing_stdio,
            implementing_streamable_http,
            implementing_oauth2,
          },
          dependencies,
        } = server;

        console.log(`\n🤖 AI Analysis:`);

        if (category) console.log(`  Category: ${category}`);
        if (server_config) console.log(`  Server Configuration: Available`);
        if (archestra_config) console.log(`  Archestra Configuration: Available`);
        if (user_config) console.log(`  User Configuration: Available`);
        if (dependencies && dependencies.length > 0) {
          console.log(`  Dependencies: ${dependencies.map((d) => `${d.name}(${d.importance})`).join(', ')}`);
        }

        if (implementing_tools !== null) {
          const protocolFeatures = [];
          if (implementing_tools) protocolFeatures.push('Tools');
          if (implementing_prompts) protocolFeatures.push('Prompts');
          if (implementing_resources) protocolFeatures.push('Resources');
          if (implementing_sampling) protocolFeatures.push('Sampling');
          if (implementing_roots) protocolFeatures.push('Roots');
          if (implementing_logging) protocolFeatures.push('Logging');
          if (implementing_stdio) protocolFeatures.push('STDIO');
          if (implementing_streamable_http) protocolFeatures.push('HTTP');
          if (implementing_oauth2) protocolFeatures.push('OAuth2');
          console.log(`  Protocol Features: ${protocolFeatures.length > 0 ? protocolFeatures.join(', ') : 'None'}`);
        }
      }
    }

    // 4. Save and return
    saveMCPServerToFile(server, filePath);
    if (showOutput) {
      console.log(`\n✅ Evaluation completed: ${githubInfo.name.replace(/#/g, '-')}.json`);
      console.log(`${'='.repeat(60)}`);
    }

    return server;
  } catch (error: any) {
    if (error.message && (error.message.startsWith('PATH_NOT_FOUND:') || error.message.startsWith('REPO_NOT_FOUND:'))) {
      if (showOutput) console.error(`❌ ${error.message}`);
      removeFromServerList(githubUrl);
      throw error;
    } else {
      if (showOutput) console.error('❌ Evaluation failed:', error);
      throw error;
    }
  }
}

/**
 * Evaluate all repositories from mcp-servers.json
 */
async function evaluateAllRepos(options: EvaluateAllReposOptions = {}): Promise<void> {
  const {
    force = false,
    updateGithub = false,
    updateCategory = false,
    updateArchestraClientConfigPermutations = false,
    updateArchestraOauth = false,
    updateCanonicalServerAndUserConfig = false,
    updateDependencies = false,
    updateProtocol = false,
    updateScore = false,
    missingOnly = false,
    concurrency: _concurrency = 10,
    limit = 0,
  } = options;

  // Ensure evaluations directory exists
  if (!fs.existsSync(MCP_SERVERS_EVALUATIONS_DIR)) {
    fs.mkdirSync(MCP_SERVERS_EVALUATIONS_DIR, { recursive: true });
  }

  // Read all GitHub URLs
  let allUrls: string[] = JSON.parse(fs.readFileSync(MCP_SERVERS_JSON_FILE_PATH, 'utf8'));

  // Filter out non-GitHub URLs (e.g., GitLab)
  let githubUrls = allUrls.filter((url) => url.includes('github.com'));

  if (githubUrls.length < allUrls.length) {
    console.log(`⚠️  Skipping ${allUrls.length - githubUrls.length} non-GitHub URLs (GitLab, etc.)`);
  }

  const existingFiles = fs.readdirSync(MCP_SERVERS_EVALUATIONS_DIR).filter((f) => f.endsWith('.json'));

  // Filter to only missing servers if --missing-only flag is set
  if (missingOnly) {
    const originalCount = githubUrls.length;
    githubUrls = githubUrls.filter((url) => {
      const githubInfo = parseGitHubUrl(url);
      const sanitizedName = githubInfo.name.replace(/#/g, '-');
      const fileName = `${sanitizedName}.json`;
      const filePath = path.join(MCP_SERVERS_EVALUATIONS_DIR, fileName);
      return !fs.existsSync(filePath);
    });
    console.log(`Filtering to missing servers only: ${githubUrls.length} of ${originalCount} servers need evaluation`);
  }

  // Apply limit if specified
  if (limit && limit > 0) {
    githubUrls = githubUrls.slice(0, limit);
  }

  // Determine concurrency based on whether we have a token
  const hasToken = !!process.env.GITHUB_TOKEN;
  const concurrency = _concurrency || (hasToken ? 10 : 3);

  console.log(`📊 Batch Evaluation
Total servers: ${githubUrls.length}${
    limit ? ` (limited from ${JSON.parse(fs.readFileSync(MCP_SERVERS_JSON_FILE_PATH, 'utf8')).length})` : ''
  }
Existing evaluations: ${existingFiles.length}
Concurrency: ${concurrency} parallel requests
Options: ${Object.entries(options)
    .filter(([k, v]) => v && k !== 'concurrency' && k !== 'limit')
    .map(([k]) => k)
    .join(', ')}\n`);

  const stats = { processed: 0, updated: 0, created: 0, failed: 0, removed: 0 };
  const startTime = Date.now();

  // Process in batches
  for (let i = 0; i < githubUrls.length; i += concurrency) {
    const batch = githubUrls.slice(i, i + concurrency);

    // Show progress
    if (i > 0) {
      const pct = Math.round((i / githubUrls.length) * 100);
      console.log(`\n📊 Progress: ${i}/${githubUrls.length} (${pct}%)`);
      console.log(
        `   Created: ${stats.created}, Updated: ${stats.updated}, Failed: ${stats.failed}, Removed: ${stats.removed}`
      );
    }

    // Process batch concurrently
    const promises = batch.map(async (url) => {
      if (!url) return;

      try {
        const githubInfo = parseGitHubUrl(url);
        const sanitizedName = githubInfo.name.replace(/#/g, '-');
        const fileName = `${sanitizedName}.json`;
        const filePath = path.join(MCP_SERVERS_EVALUATIONS_DIR, fileName);
        const exists = fs.existsSync(filePath);

        // Skip if exists and no updates requested
        if (
          exists &&
          !updateGithub &&
          !updateCategory &&
          !updateArchestraClientConfigPermutations &&
          !updateArchestraOauth &&
          !updateCanonicalServerAndUserConfig &&
          !updateDependencies &&
          !updateProtocol &&
          !updateScore &&
          !force
        ) {
          return;
        }

        // Evaluate with output suppressed for batch mode
        await evaluateSingleRepo(url, {
          ...options,
          showOutput: false,
        });

        stats.processed++;
        if (exists) {
          stats.updated++;
        } else {
          stats.created++;
        }
      } catch (error: any) {
        stats.failed++;
        if (
          error.message &&
          (error.message.startsWith('PATH_NOT_FOUND:') || error.message.startsWith('REPO_NOT_FOUND:'))
        ) {
          stats.removed++;
        } else {
          console.error(`Failed: ${url} - ${error.message}`);
        }
      }
    });

    await Promise.all(promises);

    // Rate limiting between batches
    if (stats.created > 0 && !hasToken) {
      await sleep(1000);
    } else if (stats.created > 0) {
      await sleep(200);
    }
  }

  // Summary
  const duration = Math.round((Date.now() - startTime) / 60000);
  console.log(`
✅ Complete!
   Created: ${stats.created}
   Updated: ${stats.updated}
   Failed: ${stats.failed}
   Removed: ${stats.removed}
   Total processed: ${stats.processed}
   Time: ${duration} minutes`);
}

/**
 * Format JSON files with prettier
 */
function formatEvaluationFiles(): void {
  try {
    console.log('\n📝 Formatting evaluation files with prettier...');
    execSync(`npx prettier --write "${MCP_SERVERS_EVALUATIONS_DIR}/*.json"`, {
      stdio: 'inherit',
      cwd: path.resolve(MCP_SERVERS_EVALUATIONS_DIR, '../../..'), // Go back to app directory
    });
    console.log('✅ Formatting complete');
  } catch (error) {
    console.warn('⚠️  Failed to format files with prettier:', error);
    // Don't fail the whole process if prettier fails
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  // Show help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`🔍 MCP Server Evaluation Script

Usage: npm run evaluate-catalog [options] [github-url]

Update Options:
  --github                                 Update GitHub data (stars, issues, README)
  --category                               Update category classification
  --archestra-client-config-permutations   Update Archestra client config permutations
  --archestra-oauth                        Update Archestra oauth related configurations
  --canonical-server-and-user-config       Update canonical server and user config
  --dependencies                           Update library dependencies
  --protocol                               Update MCP protocol features implementation
  --score                                  Update trust scores
  --all                                    Fill all missing data (respects existing data unless --force)
  (no flags)                               Fill in missing data only

Control Options:
  --force                Force update even if data already exists (overwrites existing data)
  --missing-only         Only process servers that don't have evaluation files
  --model <name>         LLM model to use (default: gemini-2.5-pro)
                         Supports Ollama models and Gemini models (e.g., gemini-1.5-flash)
  --concurrency <n>      Number of parallel requests (default: 10 with token, 3 without)
  --limit <n>            Process only the first N servers

Examples:
  npm run evaluate-catalog https://github.com/org/repo
  npm run evaluate-catalog --github --force
  npm run evaluate-catalog --category --model llama2
  npm run evaluate-catalog --category --model gemini-1.5-flash
  npm run evaluate-catalog --all --concurrency 20
  npm run evaluate-catalog --dependencies --limit 10
  npm run evaluate-catalog --missing-only --all
  npm run evaluate-catalog --missing-only --all --concurrency 5

Note: For Gemini models, set GEMINI_API_KEY or GOOGLE_API_KEY environment variable`);
    return;
  }

  // Parse options
  const options: EvaluateAllReposOptions = {
    updateGithub: args.includes('--github'),
    updateCategory: args.includes('--category'),
    updateArchestraClientConfigPermutations: args.includes('--archestra-client-config-permutations'),
    updateArchestraOauth: args.includes('--archestra-oauth'),
    updateCanonicalServerAndUserConfig: args.includes('--canonical-server-and-user-config'),
    updateDependencies: args.includes('--dependencies'),
    updateProtocol: args.includes('--protocol'),
    updateScore: args.includes('--score'),
    updateAll: args.includes('--all'),
    force: args.includes('--force'),
    missingOnly: args.includes('--missing-only'),
    model: args.includes('--model') ? args[args.indexOf('--model') + 1] : 'gemini-2.5-pro',
    concurrency: args.includes('--concurrency')
      ? parseInt(args[args.indexOf('--concurrency') + 1]) || undefined
      : undefined,
    limit: args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) || undefined : undefined,
  };

  // Apply --all flag
  if (options.updateAll) {
    // When --all is used, we still want to respect existing data unless --force is used
    // These flags will be used to check if we should update missing data
    options.updateGithub = true;
    options.updateCategory = true;
    options.updateArchestraClientConfigPermutations = true;
    options.updateArchestraOauth = true;
    options.updateCanonicalServerAndUserConfig = true;
    options.updateDependencies = true;
    options.updateProtocol = true;
    options.updateScore = true;
  }

  const url = args.find((arg) => arg.includes('://') || arg.includes('github.com'));

  // Check GitHub token
  if (!process.env.GITHUB_TOKEN) {
    console.log(`⚠️  No GITHUB_TOKEN found. You may hit rate limits.
   Get a token at: https://github.com/settings/tokens\n`);
  }

  // Single repo evaluation
  if (url) {
    if (!url.includes('github.com')) {
      console.log(`⚠️  Skipping non-GitHub URL: ${url}`);
      console.log('   This script only supports GitHub repositories.');
      return;
    }
    await evaluateSingleRepo(url, options);
  } else {
    // Batch evaluation
    await evaluateAllRepos(options);
  }

  // Format all evaluation files with prettier
  formatEvaluationFiles();
}

// Run the script
if (require.main === module) {
  main().catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
}

export { evaluateAllRepos, evaluateSingleRepo };
