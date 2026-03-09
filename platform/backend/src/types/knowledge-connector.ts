import { z } from "zod";

// ===== Connector Type =====

const JIRA = z.literal("jira");
const CONFLUENCE = z.literal("confluence");
const GITHUB = z.literal("github");
const GITLAB = z.literal("gitlab");

export const ConnectorTypeSchema = z.union([JIRA, CONFLUENCE, GITHUB, GITLAB]);
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;

// ===== Connector Sync Status =====

export const ConnectorSyncStatusSchema = z.enum([
  "running",
  "success",
  "failed",
  "partial",
]);
export type ConnectorSyncStatus = z.infer<typeof ConnectorSyncStatusSchema>;

// ===== Connector Credentials =====

export const ConnectorCredentialsSchema = z.object({
  email: z.string().optional(),
  apiToken: z.string(),
});
export type ConnectorCredentials = z.infer<typeof ConnectorCredentialsSchema>;

// ===== Shared =====

/** Use for any connector URL field — normalizes trailing slashes at parse time. */
const connectorUrlSchema = z.string().transform(stripTrailingSlashes);

// ===== Jira Config & Checkpoint =====

export const JiraConfigSchema = z.object({
  type: JIRA,
  jiraBaseUrl: connectorUrlSchema,
  isCloud: z.boolean(),
  projectKey: z.string().optional(),
  jqlQuery: z.string().optional(),
  commentEmailBlacklist: z.array(z.string()).optional(),
  labelsToSkip: z.array(z.string()).optional(),
});
export type JiraConfig = z.infer<typeof JiraConfigSchema>;

export const JiraCheckpointSchema = z.object({
  type: JIRA,
  lastSyncedAt: z.string().optional(),
  lastIssueKey: z.string().optional(),
  /** Raw Jira timestamp with timezone offset (e.g. "2026-03-09T11:05:52.774-0400") for correct JQL date formatting. */
  lastRawUpdatedAt: z.string().optional(),
});
export type JiraCheckpoint = z.infer<typeof JiraCheckpointSchema>;

// ===== Confluence Config & Checkpoint =====

export const ConfluenceConfigSchema = z.object({
  type: CONFLUENCE,
  confluenceUrl: connectorUrlSchema,
  isCloud: z.boolean(),
  spaceKeys: z.array(z.string()).optional(),
  pageIds: z.array(z.string()).optional(),
  cqlQuery: z.string().optional(),
  labelsToSkip: z.array(z.string()).optional(),
  batchSize: z.number().optional(),
});
export type ConfluenceConfig = z.infer<typeof ConfluenceConfigSchema>;

export const ConfluenceCheckpointSchema = z.object({
  type: CONFLUENCE,
  lastSyncedAt: z.string().optional(),
  lastPageId: z.string().optional(),
  /** Raw Confluence timestamp with timezone offset for correct CQL date formatting. */
  lastRawModifiedAt: z.string().optional(),
});
export type ConfluenceCheckpoint = z.infer<typeof ConfluenceCheckpointSchema>;

// ===== GitHub Config & Checkpoint =====

export const GithubConfigSchema = z.object({
  type: GITHUB,
  githubUrl: connectorUrlSchema,
  owner: z.string(),
  repos: z.array(z.string()).optional(),
  includeIssues: z.boolean().optional(),
  includePullRequests: z.boolean().optional(),
  labelsToSkip: z.array(z.string()).optional(),
});
export type GithubConfig = z.infer<typeof GithubConfigSchema>;

export const GithubCheckpointSchema = z.object({
  type: GITHUB,
  lastSyncedAt: z.string().optional(),
});
export type GithubCheckpoint = z.infer<typeof GithubCheckpointSchema>;

// ===== GitLab Config & Checkpoint =====

export const GitlabConfigSchema = z.object({
  type: GITLAB,
  gitlabUrl: connectorUrlSchema,
  projectIds: z.array(z.number()).optional(),
  groupId: z.string().optional(),
  includeIssues: z.boolean().optional(),
  includeMergeRequests: z.boolean().optional(),
  labelsToSkip: z.array(z.string()).optional(),
});
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>;

export const GitlabCheckpointSchema = z.object({
  type: GITLAB,
  lastSyncedAt: z.string().optional(),
});
export type GitlabCheckpoint = z.infer<typeof GitlabCheckpointSchema>;

// ===== Discriminated Unions =====

export const ConnectorConfigSchema = z.discriminatedUnion("type", [
  JiraConfigSchema,
  ConfluenceConfigSchema,
  GithubConfigSchema,
  GitlabConfigSchema,
]);
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;

export const ConnectorCheckpointSchema = z.discriminatedUnion("type", [
  JiraCheckpointSchema,
  ConfluenceCheckpointSchema,
  GithubCheckpointSchema,
  GitlabCheckpointSchema,
]);
export type ConnectorCheckpoint = z.infer<typeof ConnectorCheckpointSchema>;

// ===== Sync Types =====

export interface ConnectorDocument {
  id: string;
  title: string;
  content: string;
  sourceUrl?: string;
  metadata: Record<string, unknown>;
  updatedAt?: Date;
  /** Access control permissions extracted from the source system */
  permissions?: {
    users?: string[];
    groups?: string[];
    isPublic?: boolean;
  };
}

export interface ConnectorSyncBatch {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  hasMore: boolean;
}

// ===== Internal helpers =====

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface Connector {
  type: ConnectorType;

  validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }>;

  testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }>;

  /** Estimate the total number of items to sync (for progress display). Returns null if unknown. */
  estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null>;

  sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch>;
}
