import { z } from "zod";

// ---------------------------------------------------------------------------
// Base interfaces
// ---------------------------------------------------------------------------

export interface SyncedDocument {
  id: string;
  title: string;
  content: string;
  url: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface SyncResult<TCheckpoint> {
  checkpoint: TCheckpoint;
  synced: number;
  skipped: number;
  errors: number;
}

export interface KnowledgeConnectorBase<TConfig, TCheckpoint> {
  readonly type: string;
  validateConfig(config: TConfig): Promise<void>;
  testConnection(config: TConfig): Promise<void>;
  sync(
    config: TConfig,
    checkpoint: TCheckpoint | null,
    onDocument: (doc: SyncedDocument) => Promise<void>
  ): Promise<SyncResult<TCheckpoint>>;
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export const JiraConfigSchema = z.object({
  type: z.literal("jira"),
  instanceUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
  projectKeys: z.array(z.string()).optional(),
});

export const JiraCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type JiraConfig = z.infer<typeof JiraConfigSchema>;
export type JiraCheckpoint = z.infer<typeof JiraCheckpointSchema>;

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

export const ConfluenceConfigSchema = z.object({
  type: z.literal("confluence"),
  instanceUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
  spaceKeys: z.array(z.string()).optional(),
});

export const ConfluenceCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;
export type ConfluenceCheckpoint = z.infer<typeof ConfluenceCheckpointSchema>;

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const GitHubConfigSchema = z.object({
  type: z.literal("github"),
  accessToken: z.string().min(1),
  repositories: z.array(z.string()).optional(),
});

export const GitHubCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type GitHubCheckpoint = z.infer<typeof GitHubCheckpointSchema>;

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export const GitLabConfigSchema = z.object({
  type: z.literal("gitlab"),
  instanceUrl: z.string().url().optional(),
  accessToken: z.string().min(1),
  projectIds: z.array(z.string()).optional(),
});

export const GitLabCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;
export type GitLabCheckpoint = z.infer<typeof GitLabCheckpointSchema>;

// ---------------------------------------------------------------------------
// ServiceNow
// ---------------------------------------------------------------------------

export const ServiceNowConfigSchema = z.object({
  type: z.literal("servicenow"),
  instanceUrl: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
  tables: z.array(z.string()).optional(),
});

export const ServiceNowCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type ServiceNowConfig = z.infer<typeof ServiceNowConfigSchema>;
export type ServiceNowCheckpoint = z.infer<typeof ServiceNowCheckpointSchema>;

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

export const NotionConfigSchema = z.object({
  type: z.literal("notion"),
  integrationToken: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("secret_"), {
      message: 'Notion Integration Token must start with "secret_"',
    }),
  databaseIds: z.array(z.string()).optional(),
  pageIds: z.array(z.string()).optional(),
});

export const NotionCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type NotionConfig = z.infer<typeof NotionConfigSchema>;
export type NotionCheckpoint = z.infer<typeof NotionCheckpointSchema>;

// ---------------------------------------------------------------------------
// Discriminated union
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
