import { z } from "zod";

// ===== Connector Type =====

const JIRA = z.literal("jira");
const CONFLUENCE = z.literal("confluence");

export const ConnectorTypeSchema = z.union([JIRA, CONFLUENCE]);
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;

// ===== Connector Credentials =====

export const ConnectorCredentialsSchema = z.object({
  email: z.string(),
  apiToken: z.string(),
});
export type ConnectorCredentials = z.infer<typeof ConnectorCredentialsSchema>;

// ===== Jira Config & Checkpoint =====

export const JiraConfigSchema = z.object({
  type: JIRA,
  jiraBaseUrl: z.string().transform(stripTrailingSlashes),
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
});
export type JiraCheckpoint = z.infer<typeof JiraCheckpointSchema>;

// ===== Confluence Config & Checkpoint =====

export const ConfluenceConfigSchema = z.object({
  type: CONFLUENCE,
  confluenceUrl: z.string().transform(stripTrailingSlashes),
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
});
export type ConfluenceCheckpoint = z.infer<typeof ConfluenceCheckpointSchema>;

// ===== Discriminated Unions =====

export const ConnectorConfigSchema = z.discriminatedUnion("type", [
  JiraConfigSchema,
  ConfluenceConfigSchema,
]);
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;

export const ConnectorCheckpointSchema = z.discriminatedUnion("type", [
  JiraCheckpointSchema,
  ConfluenceCheckpointSchema,
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

  sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch>;
}
