import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared document shape produced by every connector
// ---------------------------------------------------------------------------

export const KnowledgeDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  url: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;

// ---------------------------------------------------------------------------
// Result returned by every connector's sync()
// ---------------------------------------------------------------------------

export const KnowledgeConnectorResultSchema = z.object({
  documents: z.array(KnowledgeDocumentSchema),
  errors: z.array(z.string()),
  checkpoint: z.record(z.unknown()).optional(),
});

export type KnowledgeConnectorResult = z.infer<
  typeof KnowledgeConnectorResultSchema
>;

// ---------------------------------------------------------------------------
// Per-connector config schemas
// ---------------------------------------------------------------------------

// -- Jira -------------------------------------------------------------------
export const JiraConfigSchema = z.object({
  instanceUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
  projectKeys: z.array(z.string()).optional(),
});

export type JiraConfig = z.infer<typeof JiraConfigSchema>;

export const JiraCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type JiraCheckpoint = z.infer<typeof JiraCheckpointSchema>;

// -- Confluence -------------------------------------------------------------
export const ConfluenceConfigSchema = z.object({
  instanceUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
  spaceKeys: z.array(z.string()).optional(),
});

export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;

export const ConfluenceCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type ConfluenceCheckpoint = z.infer<typeof ConfluenceCheckpointSchema>;

// -- GitHub -----------------------------------------------------------------
export const GitHubConfigSchema = z.object({
  accessToken: z.string().min(1),
  repositories: z.array(z.string()).optional(),
  organization: z.string().optional(),
});

export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

export const GitHubCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type GitHubCheckpoint = z.infer<typeof GitHubCheckpointSchema>;

// -- GitLab -----------------------------------------------------------------
export const GitLabConfigSchema = z.object({
  instanceUrl: z.string().url().optional(),
  accessToken: z.string().min(1),
  groupId: z.string().optional(),
  projectIds: z.array(z.string()).optional(),
});

export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;

export const GitLabCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type GitLabCheckpoint = z.infer<typeof GitLabCheckpointSchema>;

// -- ServiceNow -------------------------------------------------------------
export const ServiceNowConfigSchema = z.object({
  instanceUrl: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
  tables: z.array(z.string()).optional(),
});

export type ServiceNowConfig = z.infer<typeof ServiceNowConfigSchema>;

export const ServiceNowCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type ServiceNowCheckpoint = z.infer<typeof ServiceNowCheckpointSchema>;

// -- Notion -----------------------------------------------------------------
export const NotionConfigSchema = z.object({
  /** Notion Integration Token (starts with "secret_") */
  integrationToken: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("secret_"), {
      message: 'Integration token must start with "secret_"',
    }),
  /** Restrict sync to specific database IDs */
  databaseIds: z.array(z.string()).optional(),
  /** Restrict sync to specific page IDs */
  pageIds: z.array(z.string()).optional(),
});

export type NotionConfig = z.infer<typeof NotionConfigSchema>;

export const NotionCheckpointSchema = z.object({
  /** ISO-8601 timestamp of the last successful sync */
  lastSyncedAt: z.string().optional(),
});

export type NotionCheckpoint = z.infer<typeof NotionCheckpointSchema>;

// ---------------------------------------------------------------------------
// Discriminated union — connector type → config
// ---------------------------------------------------------------------------

export const KnowledgeConnectorConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("jira"), jira: JiraConfigSchema }),
  z.object({ type: z.literal("confluence"), confluence: ConfluenceConfigSchema }),
  z.object({ type: z.literal("github"), github: GitHubConfigSchema }),
  z.object({ type: z.literal("gitlab"), gitlab: GitLabConfigSchema }),
  z.object({ type: z.literal("servicenow"), servicenow: ServiceNowConfigSchema }),
  z.object({ type: z.literal("notion"), notion: NotionConfigSchema }),
]);

export type KnowledgeConnectorConfig = z.infer<
  typeof KnowledgeConnectorConfigSchema
>;
