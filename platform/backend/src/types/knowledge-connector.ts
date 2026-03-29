import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const BaseCheckpointSchema = z.object({
  lastSyncedAt: z.string().datetime().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export const JiraConfigSchema = z.object({
  type: z.literal("jira"),
  credentials: z.object({
    instanceUrl: z.string().url(),
    email: z.string().email(),
    apiToken: z.string().min(1),
  }),
  projectKeys: z.array(z.string()).optional(),
});

export const JiraCheckpointSchema = BaseCheckpointSchema;

export type JiraConfig = z.infer<typeof JiraConfigSchema>;
export type JiraCheckpoint = z.infer<typeof JiraCheckpointSchema>;

// ---------------------------------------------------------------------------
// Confluence
// ---------------------------------------------------------------------------

export const ConfluenceConfigSchema = z.object({
  type: z.literal("confluence"),
  credentials: z.object({
    instanceUrl: z.string().url(),
    email: z.string().email(),
    apiToken: z.string().min(1),
  }),
  spaceKeys: z.array(z.string()).optional(),
});

export const ConfluenceCheckpointSchema = BaseCheckpointSchema;

export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;
export type ConfluenceCheckpoint = z.infer<typeof ConfluenceCheckpointSchema>;

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const GitHubConfigSchema = z.object({
  type: z.literal("github"),
  credentials: z.object({
    accessToken: z.string().min(1),
  }),
  repositories: z.array(z.string()).optional(),
  organization: z.string().optional(),
});

export const GitHubCheckpointSchema = BaseCheckpointSchema;

export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type GitHubCheckpoint = z.infer<typeof GitHubCheckpointSchema>;

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

export const GitLabConfigSchema = z.object({
  type: z.literal("gitlab"),
  credentials: z.object({
    instanceUrl: z.string().url().optional().default("https://gitlab.com"),
    accessToken: z.string().min(1),
  }),
  projectIds: z.array(z.union([z.string(), z.number()])).optional(),
  groupIds: z.array(z.union([z.string(), z.number()])).optional(),
});

export const GitLabCheckpointSchema = BaseCheckpointSchema;

export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;
export type GitLabCheckpoint = z.infer<typeof GitLabCheckpointSchema>;

// ---------------------------------------------------------------------------
// ServiceNow
// ---------------------------------------------------------------------------

export const ServiceNowConfigSchema = z.object({
  type: z.literal("servicenow"),
  credentials: z.object({
    instanceUrl: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  tables: z.array(z.string()).optional(),
});

export const ServiceNowCheckpointSchema = BaseCheckpointSchema;

export type ServiceNowConfig = z.infer<typeof ServiceNowConfigSchema>;
export type ServiceNowCheckpoint = z.infer<typeof ServiceNowCheckpointSchema>;

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

export const NotionConfigSchema = z.object({
  type: z.literal("notion"),
  credentials: z.object({
    integrationToken: z
      .string()
      .min(1)
      .refine(
        (v) => v.startsWith("secret_") || v.startsWith("ntn_"),
        "Integration Token must start with 'secret_' or 'ntn_'"
      ),
  }),
  /** Restrict sync to specific Notion database IDs */
  databaseIds: z.array(z.string()).optional(),
  /** Restrict sync to specific Notion page IDs */
  pageIds: z.array(z.string()).optional(),
});

export const NotionCheckpointSchema = BaseCheckpointSchema;

export type NotionConfig = z.infer<typeof NotionConfigSchema>;
export type NotionCheckpoint = z.infer<typeof NotionCheckpointSchema>;

// ---------------------------------------------------------------------------
// Discriminated union — add new connectors here
// ---------------------------------------------------------------------------

export const KnowledgeConnectorConfigSchema = z.discriminatedUnion("type", [
  JiraConfigSchema,
  ConfluenceConfigSchema,
  GitHubConfigSchema,
  GitLabConfigSchema,
  ServiceNowConfigSchema,
  NotionConfigSchema,
]);

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
