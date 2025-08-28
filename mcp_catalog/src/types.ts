import { z } from 'zod';

import {
  ArchestraConfigSchema,
  ArchestraMcpServerFullGitHubInfoSchema,
  ArchestraMcpServerGitHubRepoInfoSchema,
  ArchestraMcpServerGitHubRepoStatsSchema,
  ArchestraMcpServerManifestSchema,
  ArchestraMcpServerManifestWithScoreBreakdownSchema,
  ArchestraMcpServerProtocolFeaturesSchema,
  ArchestraOauthSchema,
  ArchestraScoreBreakdownSchema,
  ArchestraSupportedOauthProvidersSchema,
  MCPDependencySchema,
  McpServerCategorySchema,
} from '@mcpCatalog/schemas';

// Infer types from Zod schemas
export type McpServerCategory = z.infer<typeof McpServerCategorySchema>;
export type MCPDependency = z.infer<typeof MCPDependencySchema>;
export type ArchestraSupportedOauthProviders = z.infer<typeof ArchestraSupportedOauthProvidersSchema>;
export type ArchestraOauth = z.infer<typeof ArchestraOauthSchema>;
export type ArchestraConfig = z.infer<typeof ArchestraConfigSchema>;
export type ArchestraScoreBreakdown = z.infer<typeof ArchestraScoreBreakdownSchema>;
export type ArchestraMcpServerGitHubRepoInfo = z.infer<typeof ArchestraMcpServerGitHubRepoInfoSchema>;
export type ArchestraMcpServerGitHubRepoStats = z.infer<typeof ArchestraMcpServerGitHubRepoStatsSchema>;
export type ArchestraMcpServerFullGitHubInfo = z.infer<typeof ArchestraMcpServerFullGitHubInfoSchema>;
export type ArchestraMcpServerProtocolFeatures = z.infer<typeof ArchestraMcpServerProtocolFeaturesSchema>;
export type ArchestraMcpServerManifest = z.infer<typeof ArchestraMcpServerManifestSchema>;
export type ArchestraMcpServerManifestWithScoreBreakdown = z.infer<
  typeof ArchestraMcpServerManifestWithScoreBreakdownSchema
>;
