import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface SyncResult<TCheckpoint> {
  checkpoint: TCheckpoint;
  documentsProcessed: number;
  errors: string[];
}

export interface KnowledgeConnector<TConfig, TCheckpoint> {
  validateConfig(): Promise<void>;
  testConnection(): Promise<void>;
  sync(
    checkpoint: TCheckpoint | null,
    onDocument: (doc: KnowledgeDocument) => Promise<void>
  ): Promise<SyncResult<TCheckpoint>>;
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export const JiraCredentialsSchema = z.object({
  instanceUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
});

export const JiraConfigSchema = z.object({
  type: z.literal("jira"),
  credentials: JiraCredentialsSchema,
  projectKeys: z.array(z.string()).optional(),
});

export const JiraCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime(),
});

export type JiraConfig = z.infer<typeof JiraConfigSchema>;
export type JiraCheckpoint = z.infer<typeof JiraCheckpointSchema>;

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

export const ConfluenceCredentialsSchema = z.object({
  instanceUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
});

export const ConfluenceConfigSchema = z.object({
  type: z.literal("confluence"),
  credentials: ConfluenceCredentialsSchema,
  spaceKeys: z.array(z.string()).optional(),
});

export const ConfluenceCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime(),
});

export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;
export type ConfluenceCheckpoint = z.infer<typeof ConfluenceCheckpointSchema>;

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const GitHubCredentialsSchema = z.object({
  personalAccessToken: z.string().min(1),
});

export const GitHubConfigSchema = z.object({
  type: z.literal("github"),
  credentials: GitHubCredentialsSchema,
  repositories: z.array(z.string()).optional(),
  organization: z.string().optional(),
});

export const GitHubCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime(),
});

export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type GitHubCheckpoint = z.infer<typeof GitHubCheckpointSchema>;

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export const GitLabCredentialsSchema = z.object({
  instanceUrl: z.string().url(),
  personalAccessToken: z.string().min(1),
});

export const GitLabConfigSchema = z.object({
  type: z.literal("gitlab"),
  credentials: GitLabCredentialsSchema,
  projectIds: z.array(z.string()).optional(),
  groupId: z.string().optional(),
});

export const GitLabCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime(),
});

export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;
export type GitLabCheckpoint = z.infer<typeof GitLabCheckpointSchema>;

// ---------------------------------------------------------------------------
// ServiceNow
// ---------------------------------------------------------------------------

export const ServiceNowCredentialsSchema = z.object({
  instanceUrl: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
});

export const ServiceNowConfigSchema = z.object({
  type: z.literal("servicenow"),
  credentials: ServiceNowCredentialsSchema,
  tables: z.array(z.string()).optional(),
});

export const ServiceNowCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime(),
});

export type ServiceNowConfig = z.infer<typeof ServiceNowConfigSchema>;
export type ServiceNowCheckpoint = z.infer<typeof ServiceNowCheckpointSchema>;

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

export const NotionCredentialsSchema = z.object({
  integrationToken: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("secret_"), {
      message: "Notion integration token must start with 'secret_'",
    }),
});

export const NotionConfigSchema = z.object({
  type: z.literal("notion"),
  credentials: NotionCredentialsSchema,
  /** Restrict sync to specific Notion database IDs */
  databaseIds: z.array(z.string()).optional(),
  /** Restrict sync to specific Notion page IDs */
  pageIds: z.array(z.string()).optional(),
});

export const NotionCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime(),
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

export type KnowledgeConnectorType = KnowledgeConnectorConfig["type"];
