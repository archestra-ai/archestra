import {
  DxtManifestSchema,
  DxtManifestServerSchema,
  DxtUserConfigurationOptionSchema,
  McpServerConfigSchema,
} from '@anthropic-ai/dxt';
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
]);

export const MCPDependencySchema = z.object({
  name: z.string(),
  importance: z.number().min(1).max(10),
});

export const ArchestraClientConfigPermutationsSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema),
});

/**
 * NOTE: when we are ready to add more OAuth providers, we can simply add them here
 * and re-run the `evaluate-catalog.ts` script to have the catalog updated
 */
export const ArchestraSupportedOauthProvidersSchema = z.enum(['google', 'slack', 'linkedin']);

export const ArchestraOauthSchema = z.object({
  provider: ArchestraSupportedOauthProvidersSchema.nullable(),
  required: z.boolean(),
});

export const ArchestraBrowserBasedSchema = z.object({
  required: z.boolean(),
});

export const ArchestraConfigSchema = z.object({
  client_config_permutations: ArchestraClientConfigPermutationsSchema.nullable(),
  oauth: ArchestraOauthSchema,
  browser_based: ArchestraBrowserBasedSchema.optional(),
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

export const ArchestraMcpServerGitHubRepoStatsSchema = z.object({
  stars: z.number(),
  contributors: z.number(),
  issues: z.number(),
  releases: z.boolean(),
  ci_cd: z.boolean(),
  latest_commit_hash: z.string().nullable(),
});

export const ArchestraMcpServerFullGitHubInfoSchema = ArchestraMcpServerGitHubRepoInfoSchema.merge(
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

export const ArchestraMcpServerManifestSchema = DxtManifestSchema.omit({ repository: true })
  .extend({
    /**
     * Machine-readable name (used for CLI, APIs)
     *
     * https://github.com/anthropics/dxt/blob/main/MANIFEST.md#field-definitions
     */
    name: z.string(),

    /**
     * Human-friendly name for UI display
     *
     * `display_name` in `DxtManifestSchema` is marked as optional, here we make it required
     *
     * https://github.com/anthropics/dxt/blob/main/MANIFEST.md#field-definitions
     */
    display_name: z.string(),

    readme: z.string().nullable(),
    category: McpServerCategorySchema.nullable(),
    quality_score: z.number().min(0).max(100).nullable(),
    archestra_config: ArchestraConfigSchema,
    github_info: ArchestraMcpServerFullGitHubInfoSchema,
    programming_language: z.string(),
    framework: z.string().nullable(),
    last_scraped_at: z.string().nullable(),
    evaluation_model: z.string().nullable(),
    protocol_features: ArchestraMcpServerProtocolFeaturesSchema,
    dependencies: z.array(MCPDependencySchema),
    raw_dependencies: z.string().nullable(),
    server_overridden: DxtManifestServerSchema.optional(),
    server_docker: z.any().optional(),
    user_config_overridden: z.record(z.string(), DxtUserConfigurationOptionSchema).optional(),
  })
  .openapi('ArchestraMcpServerManifest');

export const ArchestraMcpServerManifestWithScoreBreakdownSchema = ArchestraMcpServerManifestSchema.extend({
  score_breakdown: ArchestraScoreBreakdownSchema,
}).openapi('ArchestraMcpServerManifestWithScoreBreakdown');
