import {
  McpServerConfigSchema,
  McpbManifestSchema,
  McpbUserConfigurationOptionSchema,
} from '@anthropic-ai/mcpb/schemas/0.3';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/**
 * NOTE! don't remove this, this is super important to get the openapi schema export working correctly
 *
 * See https://github.com/asteasolutions/zod-to-openapi/blob/be536b7128925842c1d41e7ab4fb10e034e71a6e/README.md#example-2---require-syntax
 */
extendZodWithOpenApi(z);

export const McpServerCategorySchema = z.enum([
  'Aggregators',
  'Art & Culture',
  'Healthcare',
  'Browser Automation',
  'Cloud',
  'Development',
  'CLI Tools',
  'Communication',
  'Data',
  'Logistics',
  'Data Science',
  'IoT',
  'File Management',
  'Finance',
  'Gaming',
  'Knowledge',
  'Location',
  'Marketing',
  'Monitoring',
  'Media',
  'AI Tools',
  'Search',
  'Security',
  'Social Media',
  'Sports',
  'Support',
  'Translation',
  'Audio',
  'Travel',
  'Messengers',
  'Email',
  'CRM',
  'Enterprise',
  'Job Search',
  'Local files',
  'General',
  'MCP Apps Demo',
]);

export const MCPDependencySchema = z.object({
  name: z.string(),
  importance: z.number().min(1).max(10),
});

// Extended MCP server config with docker_image support
const ExtendedMcpServerConfigSchema = McpServerConfigSchema.extend({
  docker_image: z.string().optional(),
});

export const ArchestraClientConfigPermutationsSchema = z.record(z.string(), ExtendedMcpServerConfigSchema);

/**
 * NOTE: when we are ready to add more OAuth providers, we can simply add them here
 * and re-run the `evaluate-catalog.ts` script to have the catalog updated
 */
export const ArchestraSupportedOauthProvidersSchema = z.enum(['google', 'slack', 'linkedin']);

export const ArchestraOauthSchema = z.object({
  provider: ArchestraSupportedOauthProvidersSchema.nullable(),
  required: z.boolean(),
});

const OauthConfigSchema = z.object({
  name: z.string(),
  server_url: z.string().url(),
  auth_server_url: z.string().url().optional(), // Optional, defaults to server_url
  resource_metadata_url: z.string().url().optional(),
  client_id: z.string(),
  client_secret: z.string().optional(), // Optional for public clients, can contain env var references
  redirect_uris: z.array(z.string().url()),
  scopes: z.array(z.string()),
  description: z.string().optional(),
  well_known_url: z.string().url().optional(), // Optional specific well-known URL for this provider
  default_scopes: z.array(z.string()), // Fallback scopes when discovery fails
  supports_resource_metadata: z.boolean(), // Whether to attempt resource metadata discovery
  generic_oauth: z.boolean().optional(), // Use generic OAuth 2.0 flow instead of MCP SDK
  token_endpoint: z.string().url().optional(), // Token endpoint for generic OAuth
  access_token_env_var: z.string().optional(), // Environment variable name to store access token
  requires_proxy: z.boolean().optional(), // Whether this provider requires oauth-proxy for client secrets
  provider_name: z.string().optional(), // Provider name for token mapping lookup (e.g., 'slack-browser')
  browser_auth: z.boolean().optional(), // Whether this uses browser authentication
  streamable_http_url: z.string().url().optional(), // URL for streamable HTTP MCP servers
  streamable_http_port: z.number().optional(), // Port for streamable HTTP MCP servers
});

const ArchestraBrowserBasedSchema = z.object({
  required: z.boolean(),
});

const ArchestraConfigSchema = z.object({
  client_config_permutations: ArchestraClientConfigPermutationsSchema.nullable(),
  oauth: ArchestraOauthSchema,
  browser_based: ArchestraBrowserBasedSchema.optional(),
  works_in_archestra: z.boolean(),
});

export const ArchestraScoreBreakdownSchema = z.object({
  mcp_protocol: z.number(),
  github_metrics: z.number(),
  deployment_maturity: z.number(),
  documentation: z.number(),
  dependencies: z.number(),
  badge_usage: z.number(),
  total: z.number(),
});

export const ArchestraMcpServerGitHubRepoInfoSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  url: z.string(),
  name: z.string(),
  path: z.string().nullable(),
});

const ArchestraMcpServerGitHubRepoStatsSchema = z.object({
  stars: z.number(),
  contributors: z.number(),
  issues: z.number(),
  releases: z.boolean(),
  ci_cd: z.boolean(),
  latest_commit_hash: z.string().nullable(),
});

const ArchestraMcpServerFullGitHubInfoSchema = ArchestraMcpServerGitHubRepoInfoSchema.merge(
  ArchestraMcpServerGitHubRepoStatsSchema
);

export const ArchestraMcpServerProtocolFeaturesSchema = z.object({
  implementing_tools: z.boolean(),
  implementing_prompts: z.boolean(),
  implementing_resources: z.boolean(),
  implementing_sampling: z.boolean(),
  implementing_roots: z.boolean(),
  implementing_logging: z.boolean(),
  implementing_stdio: z.boolean(),
  implementing_streamable_http: z.boolean(),
  implementing_oauth2: z.boolean(),
});

const LogMonitorSchema = z.object({
  type: z.enum(['log-monitor']),
  provider: z.enum(['whatsapp']),
});

const LocalServerSchema = McpServerConfigSchema.extend({
  type: z.literal('local'),
  setup: z.array(LogMonitorSchema).optional(),
  docker_image: z.string().optional(),
  service_account: z.string().optional(),
});

const RemoteServerSchema = z.object({
  type: z.literal('remote'),
  url: z.string().url(),
  docs_url: z.string().url().nullable(),
});

// Extend the user config option schema to support the 'mounted' property
// which indicates the config value should be mounted as a file in the container
const ExtendedUserConfigurationOptionSchema = McpbUserConfigurationOptionSchema.extend({
  mounted: z.boolean().optional(),
});

// Pick only the fields we need from McpbManifestSchema to avoid .omit() which
// doesn't work with schemas containing refinements in Zod 4.3+
const mcpbShape = McpbManifestSchema.shape;
const BaseManifestSchema = z.object({
  description: mcpbShape.description,
  long_description: mcpbShape.long_description,
  author: mcpbShape.author,
  homepage: mcpbShape.homepage,
  documentation: mcpbShape.documentation,
  support: mcpbShape.support,
  icon: mcpbShape.icon,
  screenshots: mcpbShape.screenshots,
  tools: mcpbShape.tools,
  tools_generated: mcpbShape.tools_generated,
  prompts: mcpbShape.prompts,
  prompts_generated: mcpbShape.prompts_generated,
  keywords: mcpbShape.keywords,
  license: mcpbShape.license,
  compatibility: mcpbShape.compatibility,
  user_config: z.record(z.string(), ExtendedUserConfigurationOptionSchema).optional(),
});

export const ArchestraMcpServerManifestSchema = BaseManifestSchema.extend({
  /**
   * Machine-readable name (used for CLI, APIs)
   */
  name: z.string(),

  /**
   * Human-friendly name for UI display
   */
  display_name: z.string(),

  /**
   * Installation instructions shown in the installation modal
   */
  instructions: z.string().optional(),
  readme: z.string().nullable(),
  category: McpServerCategorySchema.nullable(),
  quality_score: z.number().min(0).max(100).nullable(),
  archestra_config: ArchestraConfigSchema.optional(),
  github_info: ArchestraMcpServerFullGitHubInfoSchema.nullable(),
  programming_language: z.string().nullable(),
  framework: z.string().nullable(),
  last_scraped_at: z.string().nullable(),
  evaluation_model: z.string().nullable(),
  protocol_features: ArchestraMcpServerProtocolFeaturesSchema.optional(),
  dependencies: z.array(MCPDependencySchema).optional(),
  raw_dependencies: z.string().nullable(),
  oauth_config: OauthConfigSchema.optional(),

  server: z.discriminatedUnion('type', [LocalServerSchema, RemoteServerSchema]),
}).openapi('ArchestraMcpServerManifest');

export const ArchestraMcpServerManifestWithScoreBreakdownSchema = ArchestraMcpServerManifestSchema.extend({
  score_breakdown: ArchestraScoreBreakdownSchema,
}).openapi('ArchestraMcpServerManifestWithScoreBreakdown');
