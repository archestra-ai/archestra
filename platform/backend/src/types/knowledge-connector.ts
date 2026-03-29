import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const BaseConfigSchema = z.object({
  name: z.string().min(1),
  syncIntervalMinutes: z.number().int().positive().optional().default(60),
});

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export const JiraConfigSchema = BaseConfigSchema.extend({
  type: z.literal("jira"),
  instanceUrl: z.string().url(),
  projectKeys: z.array(z.string()).optional(),
});

export const JiraCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime().optional(),
});

export type JiraConfig = z.infer<typeof JiraConfigSchema>;
export type JiraCheckpoint = z.infer<typeof JiraCheckpointSchema>;

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

export const ConfluenceConfigSchema = BaseConfigSchema.extend({
  type: z.literal("confluence"),
  instanceUrl: z.string().url(),
  spaceKeys: z.array(z.string()).optional(),
});

export const ConfluenceCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime().optional(),
});

export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;
export type ConfluenceCheckpoint = z.infer<typeof ConfluenceCheckpointSchema>;

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const GitHubConfigSchema = BaseConfigSchema.extend({
  type: z.literal("github"),
  instanceUrl: z.string().url().optional(),
  repositories: z.array(z.string()).optional(),
});

export const GitHubCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime().optional(),
});

export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type GitHubCheckpoint = z.infer<typeof GitHubCheckpointSchema>;

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export const GitLabConfigSchema = BaseConfigSchema.extend({
  type: z.literal("gitlab"),
  instanceUrl: z.string().url().optional(),
  projectIds: z.array(z.string()).optional(),
});

export const GitLabCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime().optional(),
});

export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;
export type GitLabCheckpoint = z.infer<typeof GitLabCheckpointSchema>;

// ---------------------------------------------------------------------------
// ServiceNow
// ---------------------------------------------------------------------------

export const ServiceNowConfigSchema = BaseConfigSchema.extend({
  type: z.literal("servicenow"),
  instanceUrl: z.string().url(),
  tables: z.array(z.string()).optional(),
});

export const ServiceNowCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime().optional(),
});

export type ServiceNowConfig = z.infer<typeof ServiceNowConfigSchema>;
export type ServiceNowCheckpoint = z.infer<typeof ServiceNowCheckpointSchema>;

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

export const NotionConfigSchema = BaseConfigSchema.extend({
  type: z.literal("notion"),
  /** Optional: restrict sync to specific Notion database IDs */
  databaseIds: z.array(z.string()).optional(),
  /** Optional: sync only specific page IDs */
  pageIds: z.array(z.string()).optional(),
});

export const NotionCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime().optional(),
});

export type NotionConfig = z.infer<typeof NotionConfigSchema>;
export type NotionCheckpoint = z.infer<typeof NotionCheckpointSchema>;

// ---------------------------------------------------------------------------
// Discriminated union of all connector configs
// ---------------------------------------------------------------------------

export const KnowledgeConnectorConfigSchema = z.discriminatedUnion("type", [
  JiraConfigSchema,
  ConfluenceConfigSchema,
  GitHubConfigSchema,
  GitLabConfigSchema,
  ServiceNowConfigSchema,
  NotionConfigSchema,
]);

export type KnowledgeConnectorConfig = z.infer<typeof KnowledgeConnectorConfigSchema>;

export const KnowledgeConnectorCheckpointSchema = z.union([
  JiraCheckpointSchema,
  ConfluenceCheckpointSchema,
  GitHubCheckpointSchema,
  GitLabCheckpointSchema,
  ServiceNowCheckpointSchema,
  NotionCheckpointSchema,
]);

export type KnowledgeConnectorCheckpoint = z.infer<typeof KnowledgeConnectorCheckpointSchema>;

// ---------------------------------------------------------------------------
// Connector credential schemas
// ---------------------------------------------------------------------------

export const JiraCredentialSchema = z.object({
  username: z.string().min(1),
  apiToken: z.string().min(1),
});

export const ConfluenceCredentialSchema = z.object({
  username: z.string().min(1),
  apiToken: z.string().min(1),
});

export const GitHubCredentialSchema = z.object({
  accessToken: z.string().min(1),
});

export const GitLabCredentialSchema = z.object({
  accessToken: z.string().min(1),
});

export const ServiceNowCredentialSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const NotionCredentialSchema = z.object({
  integrationToken: z.string().min(1).refine(
    (t) => t.startsWith("secret_"),
    { message: "Notion Integration Token must start with 'secret_'" }
  ),
});

export type JiraCredential = z.infer<typeof JiraCredentialSchema>;
export type ConfluenceCredential = z.infer<typeof ConfluenceCredentialSchema>;
export type GitHubCredential = z.infer<typeof GitHubCredentialSchema>;
export type GitLabCredential = z.infer<typeof GitLabCredentialSchema>;
export type ServiceNowCredential = z.infer<typeof ServiceNowCredentialSchema>;
export type NotionCredential = z.infer<typeof NotionCredentialSchema>;

// ---------------------------------------------------------------------------
// Connector output types
// ---------------------------------------------------------------------------

export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  url: string;
  sourceType: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeConnectorSyncResult {
  documents: KnowledgeDocument[];
  errors: string[];
  checkpoint: KnowledgeConnectorCheckpoint;
}
