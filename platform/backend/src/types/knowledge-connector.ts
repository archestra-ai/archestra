import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const KnowledgeDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  url: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  updatedAt: z.date().optional(),
});

export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;

export const KnowledgeConnectorSyncResultSchema = z.object({
  documents: z.array(KnowledgeDocumentSchema),
  checkpoint: z.record(z.unknown()).optional(),
  errors: z.array(z.string()).optional(),
});

export type KnowledgeConnectorSyncResult = z.infer<
  typeof KnowledgeConnectorSyncResultSchema
>;

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export const JiraCredentialsSchema = z.object({
  instanceUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string(),
});

export const JiraConfigSchema = z.object({
  connectorType: z.literal("jira"),
  credentials: JiraCredentialsSchema,
  projectKeys: z.array(z.string()).optional(),
});

export type JiraConfig = z.infer<typeof JiraConfigSchema>;

export const JiraCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type JiraCheckpoint = z.infer<typeof JiraCheckpointSchema>;

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

export const ConfluenceCredentialsSchema = z.object({
  instanceUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string(),
});

export const ConfluenceConfigSchema = z.object({
  connectorType: z.literal("confluence"),
  credentials: ConfluenceCredentialsSchema,
  spaceKeys: z.array(z.string()).optional(),
});

export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;

export const ConfluenceCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type ConfluenceCheckpoint = z.infer<typeof ConfluenceCheckpointSchema>;

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const GitHubCredentialsSchema = z.object({
  accessToken: z.string(),
});

export const GitHubConfigSchema = z.object({
  connectorType: z.literal("github"),
  credentials: GitHubCredentialsSchema,
  repositories: z.array(z.string()).optional(),
  organization: z.string().optional(),
});

export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

export const GitHubCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
  cursors: z.record(z.string()).optional(),
});

export type GitHubCheckpoint = z.infer<typeof GitHubCheckpointSchema>;

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export const GitLabCredentialsSchema = z.object({
  instanceUrl: z.string().url(),
  accessToken: z.string(),
});

export const GitLabConfigSchema = z.object({
  connectorType: z.literal("gitlab"),
  credentials: GitLabCredentialsSchema,
  groupId: z.string().optional(),
  projectIds: z.array(z.string()).optional(),
});

export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;

export const GitLabCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type GitLabCheckpoint = z.infer<typeof GitLabCheckpointSchema>;

// ---------------------------------------------------------------------------
// ServiceNow
// ---------------------------------------------------------------------------

export const ServiceNowCredentialsSchema = z.object({
  instanceUrl: z.string().url(),
  username: z.string(),
  password: z.string(),
});

export const ServiceNowConfigSchema = z.object({
  connectorType: z.literal("servicenow"),
  credentials: ServiceNowCredentialsSchema,
  tables: z.array(z.string()).optional(),
});

export type ServiceNowConfig = z.infer<typeof ServiceNowConfigSchema>;

export const ServiceNowCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type ServiceNowCheckpoint = z.infer<typeof ServiceNowCheckpointSchema>;

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

export const NotionCredentialsSchema = z.object({
  integrationToken: z
    .string()
    .min(1, "Integration token is required")
    .refine((v) => v.startsWith("secret_"), {
      message: "Notion Integration Token must start with 'secret_'",
    }),
});

export const NotionConfigSchema = z.object({
  connectorType: z.literal("notion"),
  credentials: NotionCredentialsSchema,
  /** Restrict sync to pages belonging to these database IDs */
  databaseIds: z.array(z.string()).optional(),
  /** Sync only these specific page IDs */
  pageIds: z.array(z.string()).optional(),
});

export type NotionConfig = z.infer<typeof NotionConfigSchema>;

export const NotionCheckpointSchema = z.object({
  lastSyncedAt: z.string().optional(),
});

export type NotionCheckpoint = z.infer<typeof NotionCheckpointSchema>;

// ---------------------------------------------------------------------------
// Discriminated union — add every connector type here
// ---------------------------------------------------------------------------

export const KnowledgeConnectorConfigSchema = z.discriminatedUnion(
  "connectorType",
  [
    JiraConfigSchema,
    ConfluenceConfigSchema,
    GitHubConfigSchema,
    GitLabConfigSchema,
    ServiceNowConfigSchema,
    NotionConfigSchema,
  ]
);

export type KnowledgeConnectorConfig = z.infer<
  typeof KnowledgeConnectorConfigSchema
>;

export const KnowledgeConnectorCheckpointSchema = z.union([
  JiraCheckpointSchema,
  ConfluenceCheckpointSchema,
  GitHubCheckpointSchema,
  GitLabCheckpointSchema,
  ServiceNowCheckpointSchema,
  NotionCheckpointSchema,
]);

export type KnowledgeConnectorCheckpoint = z.infer<
  typeof KnowledgeConnectorCheckpointSchema
>;
