import type { z } from 'zod';

import type {
  ArchestraMcpServerGitHubRepoInfoSchema,
  ArchestraMcpServerManifestSchema,
  ArchestraScoreBreakdownSchema,
  MCPDependencySchema,
  McpServerCategorySchema,
} from '@mcpCatalog/schemas';

// Infer types from Zod schemas
export type McpServerCategory = z.infer<typeof McpServerCategorySchema>;
export type ArchestraScoreBreakdown = z.infer<typeof ArchestraScoreBreakdownSchema>;
export type ArchestraMcpServerGitHubRepoInfo = z.infer<typeof ArchestraMcpServerGitHubRepoInfoSchema>;
export type ArchestraMcpServerManifest = z.infer<typeof ArchestraMcpServerManifestSchema>;
export type MCPDependency = z.infer<typeof MCPDependencySchema>;
