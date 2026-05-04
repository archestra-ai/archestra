import type { ModelInputModality } from "@shared";
import { z } from "zod";

// ===== Connector Type =====

const JIRA = z.literal("jira");
const CONFLUENCE = z.literal("confluence");
const GITHUB = z.literal("github");
const GITLAB = z.literal("gitlab");
const SERVICENOW = z.literal("servicenow");
const NOTION = z.literal("notion");
const SHAREPOINT = z.literal("sharepoint");
const GDRIVE = z.literal("gdrive");
const DROPBOX = z.literal("dropbox");
const ONEDRIVE = z.literal("onedrive");
const ASANA = z.literal("asana");
const OUTLINE = z.literal("outline");
const LINEAR = z.literal("linear");
const SALESFORCE = z.literal("salesforce");

export const ConnectorTypeSchema = z.union([
  JIRA,
  CONFLUENCE,
  GITHUB,
  GITLAB,
  SERVICENOW,
  NOTION,
  SHAREPOINT,
  GDRIVE,
  DROPBOX,
  ONEDRIVE,
  ASANA,
  LINEAR,
  OUTLINE,
  SALESFORCE,
]);
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;

// ===== Connector Sync Status =====

export const ConnectorSyncStatusSchema = z.enum([
  "running",
  "success",
  "completed_with_errors",
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

/** Use for any connector URL field — prepends https:// if no protocol and normalizes trailing slashes at parse time. */
const connectorUrlSchema = z
  .string()
  .transform(ensureProtocol)
  .transform(stripTrailingSlashes);

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
  includeMarkdownFiles: z.boolean().optional(),
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
  includeMarkdownFiles: z.boolean().optional(),
  labelsToSkip: z.array(z.string()).optional(),
});
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>;

export const GitlabCheckpointSchema = z.object({
  type: GITLAB,
  lastSyncedAt: z.string().optional(),
});
export type GitlabCheckpoint = z.infer<typeof GitlabCheckpointSchema>;

// ===== ServiceNow Config & Checkpoint =====

export const ServiceNowConfigSchema = z.object({
  type: SERVICENOW,
  instanceUrl: connectorUrlSchema,
  includeIncidents: z.boolean().optional(),
  includeChanges: z.boolean().optional(),
  includeChangeRequests: z.boolean().optional(),
  includeProblems: z.boolean().optional(),
  includeBusinessApps: z.boolean().optional(),
  states: z.array(z.string()).optional(),
  assignmentGroups: z.array(z.string()).optional(),
  batchSize: z.number().optional(),
  syncDataForLastMonths: z.number().min(1).max(12).optional(),
});
export type ServiceNowConfig = z.infer<typeof ServiceNowConfigSchema>;

export const ServiceNowCheckpointSchema = z.object({
  type: SERVICENOW,
  lastSyncedAt: z.string().optional(),
  lastOffset: z.number().optional(),
});
export type ServiceNowCheckpoint = z.infer<typeof ServiceNowCheckpointSchema>;

// ===== Notion Config & Checkpoint =====

export const NotionConfigSchema = z.object({
  type: NOTION,
  databaseIds: z.array(z.string()).optional(),
  pageIds: z.array(z.string()).optional(),
  batchSize: z.number().optional(),
});
export type NotionConfig = z.infer<typeof NotionConfigSchema>;

export const NotionCheckpointSchema = z.object({
  type: NOTION,
  lastSyncedAt: z.string().optional(),
  lastEditedAt: z.string().optional(),
});
export type NotionCheckpoint = z.infer<typeof NotionCheckpointSchema>;

// ===== SharePoint Config & Checkpoint =====

export const SharePointConfigSchema = z.object({
  type: SHAREPOINT,
  tenantId: z.string().min(1),
  siteUrl: connectorUrlSchema,
  driveIds: z.array(z.string()).optional(),
  folderPath: z.string().optional(),
  recursive: z.boolean().optional(),
  maxDepth: z.number().int().min(1).max(100).optional(),
  includePages: z.boolean().optional(),
  batchSize: z.number().optional(),
});
export type SharePointConfig = z.infer<typeof SharePointConfigSchema>;

export const SharePointCheckpointSchema = z.object({
  type: SHAREPOINT,
  lastSyncedAt: z.string().optional(),
});
export type SharePointCheckpoint = z.infer<typeof SharePointCheckpointSchema>;

// ===== Google Drive Config & Checkpoint =====

export const GoogleDriveConfigSchema = z.object({
  type: GDRIVE,
  driveId: z.string().optional(),
  driveIds: z.array(z.string()).optional(),
  folderId: z.string().optional(),
  recursive: z.boolean().optional(),
  maxDepth: z.number().int().min(1).max(100).optional(),
  fileTypes: z.array(z.string()).optional(),
  batchSize: z.number().optional(),
});
export type GoogleDriveConfig = z.infer<typeof GoogleDriveConfigSchema>;

export const GoogleDriveCheckpointSchema = z.object({
  type: GDRIVE,
  lastSyncedAt: z.string().optional(),
});
export type GoogleDriveCheckpoint = z.infer<typeof GoogleDriveCheckpointSchema>;

// ===== Asana Config & Checkpoint =====

export const AsanaConfigSchema = z.object({
  type: ASANA,
  workspaceGid: z.string().min(1),
  projectGids: z.array(z.string()).optional(),
  tagsToSkip: z.array(z.string()).optional(),
});
export type AsanaConfig = z.infer<typeof AsanaConfigSchema>;

export const AsanaCheckpointSchema = z.object({
  type: ASANA,
  lastSyncedAt: z.string().optional(),
});
export type AsanaCheckpoint = z.infer<typeof AsanaCheckpointSchema>;

// ===== Linear Config & Checkpoint =====

export const LinearConfigSchema = z.object({
  type: LINEAR,
  linearApiUrl: connectorUrlSchema.optional().default("https://api.linear.app"),
  teamIds: z.array(z.string()).optional(),
  projectIds: z.array(z.string()).optional(),
  states: z.array(z.string()).optional(),
  includeComments: z.boolean().optional(),
  includeProjects: z.boolean().optional(),
  includeCycles: z.boolean().optional(),
  batchSize: z.number().int().positive().optional(),
});
export type LinearConfig = z.infer<typeof LinearConfigSchema>;

export const LinearCheckpointSchema = z.object({
  type: LINEAR,
  lastSyncedAt: z.string().optional(),
  /** High-water `updatedAt` (ISO) after a completed issues sweep; drives the next incremental issues lower bound. */
  lastRawUpdatedAt: z.string().optional(),
  /** Active sync phase for multi-entity runs (resume across batches). */
  linearSyncPhase: z.enum(["issues", "projects", "cycles"]).optional(),
  issuePageCursor: z.string().optional(),
  /**
   * `updatedAt: { gt }` lower bound for the in-flight issues sweep.
   * Kept stable while paginating; cleared when the issues sweep completes.
   */
  issueUpdatedAfter: z.string().optional(),
  projectLastRawUpdatedAt: z.string().optional(),
  projectPageCursor: z.string().optional(),
  projectUpdatedAfter: z.string().optional(),
  cycleLastRawUpdatedAt: z.string().optional(),
  cyclePageCursor: z.string().optional(),
  cycleUpdatedAfter: z.string().optional(),
});
export type LinearCheckpoint = z.infer<typeof LinearCheckpointSchema>;

// ===== Salesforce Config & Checkpoint =====

export const SalesforceConfigSchema = z.object({
  type: SALESFORCE,
  loginUrl: connectorUrlSchema
    .optional()
    .default("https://login.salesforce.com"),
  objects: z.array(z.string().min(1)).optional(),
  advancedObjectConfigJson: z
    .string()
    .optional()
    .refine(
      (value) => {
        if (!value) return true;
        try {
          const parsed = JSON.parse(value);
          return (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
          );
        } catch {
          return false;
        }
      },
      {
        message:
          "advancedObjectConfigJson must be valid JSON object text when provided",
      },
    ),
});
export type SalesforceConfig = z.infer<typeof SalesforceConfigSchema>;

export const SalesforceCheckpointSchema = z.object({
  type: SALESFORCE,
  lastSyncedAt: z.string().optional(),
  objectCursorMap: z.record(z.string(), z.string()).optional(),
});
export type SalesforceCheckpoint = z.infer<typeof SalesforceCheckpointSchema>;

// ===== Discriminated Unions =====

// ===== Dropbox Config & Checkpoint =====

export const DropboxConfigSchema = z.object({
  type: DROPBOX,
  rootPath: z.string().optional(),
  fileTypes: z.array(z.string()).optional(),
  batchSize: z.number().optional(),
  recursive: z.boolean().optional(),
  maxDepth: z.number().optional(),
});
export type DropboxConfig = z.infer<typeof DropboxConfigSchema>;

export const DropboxCheckpointSchema = z.object({
  type: DROPBOX,
  lastSyncedAt: z.string().optional(),
  cursor: z.string().optional(),
});
export type DropboxCheckpoint = z.infer<typeof DropboxCheckpointSchema>;

// ===== OneDrive Config & Checkpoint =====

export const OneDriveConfigSchema = z.object({
  type: ONEDRIVE,
  tenantId: z.string().min(1),
  userIds: z.array(z.string()).min(1, "At least one user ID is required"),
  folderId: z.string().optional(),
  recursive: z.boolean().optional(),
  maxDepth: z.number().int().min(1).max(100).optional(),
  fileTypes: z.array(z.string()).optional(),
  batchSize: z.number().optional(),
});
export type OneDriveConfig = z.infer<typeof OneDriveConfigSchema>;

export const OneDriveCheckpointSchema = z.object({
  type: ONEDRIVE,
  lastSyncedAt: z.string().optional(),
});
export type OneDriveCheckpoint = z.infer<typeof OneDriveCheckpointSchema>;

// ===== Outline Config & Checkpoint =====

export const OutlineConfigSchema = z.object({
  type: OUTLINE,
  outlineUrl: connectorUrlSchema,
  collectionIds: z.array(z.string()).optional(),
  batchSize: z.number().optional(),
});
export type OutlineConfig = z.infer<typeof OutlineConfigSchema>;

export const OutlineCheckpointSchema = z.object({
  type: OUTLINE,
  syncStart: z.string().optional(),
  lastCollectionId: z.string().optional(),
  lastDocumentId: z.string().optional(),
  lastSyncedAt: z.string().optional(),
});
export type OutlineCheckpoint = z.infer<typeof OutlineCheckpointSchema>;

export const ConnectorConfigSchema = z.discriminatedUnion("type", [
  JiraConfigSchema,
  ConfluenceConfigSchema,
  GithubConfigSchema,
  GitlabConfigSchema,
  ServiceNowConfigSchema,
  NotionConfigSchema,
  SharePointConfigSchema,
  GoogleDriveConfigSchema,
  DropboxConfigSchema,
  OneDriveConfigSchema,
  AsanaConfigSchema,
  LinearConfigSchema,
  OutlineConfigSchema,
  SalesforceConfigSchema,
]);
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;

export const ConnectorCheckpointSchema = z.discriminatedUnion("type", [
  JiraCheckpointSchema,
  ConfluenceCheckpointSchema,
  GithubCheckpointSchema,
  GitlabCheckpointSchema,
  ServiceNowCheckpointSchema,
  NotionCheckpointSchema,
  SharePointCheckpointSchema,
  GoogleDriveCheckpointSchema,
  DropboxCheckpointSchema,
  OneDriveCheckpointSchema,
  AsanaCheckpointSchema,
  LinearCheckpointSchema,
  OutlineCheckpointSchema,
  SalesforceCheckpointSchema,
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
  /**
   * Optional inline media (image) data. When present, the pipeline will embed
   * this as a multimodal chunk in addition to the text content.
   * Only indexed when the configured embedding model supports the given modality.
   */
  mediaContent?: {
    /** IANA MIME type, e.g. "image/jpeg" */
    mimeType: string;
    /** Base64-encoded binary data */
    data: string;
  };
}

export interface ConnectorItemFailure {
  itemId: string | number;
  resource: string;
  error: string;
}

export interface ConnectorItemSkipped {
  itemId: string | number;
  name: string;
  reason: string;
}

export interface ConnectorSyncBatch {
  documents: ConnectorDocument[];
  failures?: ConnectorItemFailure[];
  skipped?: ConnectorItemSkipped[];
  checkpoint: ConnectorCheckpoint;
  hasMore: boolean;
}

// ===== Internal helpers =====

function ensureProtocol(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return `https://${url}`;
}

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
    embeddingInputModalities?: ModelInputModality[];
  }): Promise<number | null>;

  sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
    /**
     * Input modalities supported by the configured embedding model.
     * Connectors can use this to conditionally ingest non-text content
     * (e.g. images) only when the embedding model can handle it.
     */
    embeddingInputModalities?: ModelInputModality[];
  }): AsyncGenerator<ConnectorSyncBatch>;
}
