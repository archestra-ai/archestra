import type { ModelInputModality } from "@archestra/shared";
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
const WEB_CRAWLER = z.literal("web_crawler");
const PERFORCE = z.literal("perforce");

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
  WEB_CRAWLER,
  PERFORCE,
]);
export type ConnectorType = z.infer<typeof ConnectorTypeSchema>;

// ===== Connector Sync Status =====

export const ConnectorSyncStatusSchema = z.enum([
  // A sync is enqueued but no worker has claimed it yet. Only connector
  // last-status stamps carry this; run rows are created already "running".
  "queued",
  "running",
  "success",
  "completed_with_errors",
  "failed",
  "partial",
  // A newer sync run for the same connector replaced this one. Distinct from
  // "failed" so it can be surfaced as an informational (not error) state.
  "superseded",
]);
export type ConnectorSyncStatus = z.infer<typeof ConnectorSyncStatusSchema>;

// ===== Connector Run Type (runtime-isolated job families) =====

/**
 * Which job family a `connector_runs` row belongs to. `content` is the existing
 * ingestion sync; `permission` is the runtime-isolated permission-sync pass.
 * The two families single-flight independently (composite lease index) so a
 * content run and a permission run for the same connector can run concurrently.
 */
export const ConnectorRunTypeSchema = z.enum(["content", "permission"]);
export type ConnectorRunType = z.infer<typeof ConnectorRunTypeSchema>;

// ===== Connector Credentials =====

export const ConnectorCredentialsSchema = z.object({
  email: z.string().optional(),
  apiToken: z.string(),
  // Atlassian Cloud organization admin API key for the admin/Directory APIs
  // (managed-account email resolution during permission sync). A separate
  // field because the two Atlassian API families accept different credential
  // kinds: product REST APIs take a user API token in basic auth and reject
  // org-admin API keys (observed live: every product call 401s), while the
  // admin APIs take an org-admin API key as Bearer and reject user tokens.
  adminApiKey: z.string().optional(),
  // resolved GitHub App metadata (paired with the App private key in apiToken)
  // when a connector authenticates via a github_app_configs reference
  githubApp: z
    .object({
      githubUrl: z.string(),
      appId: z.string(),
      installationId: z.string(),
    })
    .optional(),
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
  /** Single project key or comma-separated project keys. */
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
  authMethod: z.enum(["pat", "github_app"]).optional(),
  // references a github_app_configs row that holds the App credentials.
  // "" is accepted and means absent (every consumer checks truthiness): the
  // auth-method toggle cleared the field to an empty string in older
  // clients, which must not fail UUID parsing.
  githubAppConfigId: z.string().uuid().or(z.literal("")).optional(),
  repos: z.array(z.string()).optional(),
  includeIssues: z.boolean().optional(),
  includePullRequests: z.boolean().optional(),
  includeRepositoryFiles: z.boolean().optional(),
  fileTypes: z.array(z.string()).optional(),
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

// ===== Web Crawler Config & Checkpoint =====

export const WebCrawlerConfigSchema = z.object({
  type: WEB_CRAWLER,
  startUrl: z
    .string()
    .refine(hasAllowedWebCrawlerStartUrlScheme, {
      message: "startUrl must use HTTP or HTTPS",
    })
    .transform(ensureProtocol)
    .refine(isValidUrl, { message: "startUrl must be a valid URL" })
    .refine(isHttpUrl, { message: "startUrl must use HTTP or HTTPS" }),
  includePathPrefixes: z.array(z.string().min(1)).optional(),
  excludePathPatterns: z.array(z.string().min(1)).optional(),
  contentSelector: z.string().min(1).max(500).optional(),
  excludeSelectors: z.array(z.string().min(1).max(500)).optional(),
  maxPages: z.number().int().min(1).max(10_000).optional(),
  maxDepth: z.number().int().min(0).max(50).optional(),
  batchSize: z.number().int().min(1).max(100).optional(),
  requestDelayMs: z.number().int().min(0).max(10_000).optional(),
  userAgent: z.string().min(1).optional(),
  // Off by default: the crawler refuses hosts that resolve to private/internal
  // addresses to guard against SSRF. Enable only for internal sites the
  // Archestra workers are meant to reach.
  allowPrivateNetwork: z.boolean().optional(),
});
export type WebCrawlerConfig = z.infer<typeof WebCrawlerConfigSchema>;

export const WebCrawlerCheckpointSchema = z.object({
  type: WEB_CRAWLER,
  lastSyncedAt: z.string().optional(),
});
export type WebCrawlerCheckpoint = z.infer<typeof WebCrawlerCheckpointSchema>;

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

// ===== Perforce (Helix Core) Config & Checkpoint =====

/**
 * Depot path in depot syntax (e.g. `//depot/docs`). Perforce wildcard and
 * revision metacharacters (`@ # % * ...`) are rejected so user input can never
 * widen the filespecs the connector builds; `/...` and `@rev` suffixes are
 * appended internally only. A trailing `/...` or `/` is stripped at parse time.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters in depot paths is the point
const DEPOT_PATH_PATTERN = /^\/\/[^\x00-\x20@#%*/]+(?:\/[^\x00-\x20@#%*/]+)*$/;

// The .pipe() keeps the output type a plain string in the generated OpenAPI
// schema (a bare .transform() degrades response types to unknown).
const depotPathSchema = z
  .string()
  .max(1024)
  .transform(stripDepotPathSuffix)
  .pipe(
    z
      .string()
      .refine(
        (path) => DEPOT_PATH_PATTERN.test(path) && !path.includes("..."),
        {
          message:
            'Depot path must look like "//depot/path" and may not contain whitespace, control characters, or the Perforce metacharacters @ # % * ...',
        },
      ),
  );

export const PerforceConfigSchema = z.object({
  type: PERFORCE,
  /** Base URL of the P4 web server hosting the REST API (e.g. `https://perforce.example.com:8080`). */
  serverUrl: connectorUrlSchema,
  depotPaths: z.array(depotPathSchema).min(1),
  /**
   * Depot paths excluded from the sweep (prefix match under the included
   * paths). Lets one connector index a broad path while carving out large or
   * irrelevant subtrees.
   */
  excludePaths: z.array(depotPathSchema).optional(),
  /** File extensions to index (defaults applied in the connector: .md, .yaml, .yml). */
  fileTypes: z
    .array(
      z.string().regex(/^\.?[A-Za-z0-9_-]+$/, {
        message:
          'File types must be plain extensions like ".md" (letters, digits, "-", "_")',
      }),
    )
    .optional(),
});
export type PerforceConfig = z.infer<typeof PerforceConfigSchema>;

export const PerforceCheckpointSchema = z.object({
  type: PERFORCE,
  lastSyncedAt: z.string().optional(),
  /** Committed cursor: every submitted changelist up to here is fully ingested. */
  lastChangelist: z.number().int().nonnegative().optional(),
  /**
   * High-water changelist of the in-flight sweep. Present (with `filesOffset`)
   * only while a sweep is mid-run so partial/time-boxed runs resume instead of
   * restarting; cleared when the sweep commits into `lastChangelist`.
   */
  targetChangelist: z.number().int().nonnegative().optional(),
  /** Submit time of `targetChangelist` (ISO), carried so a resumed sweep commits the right `lastSyncedAt`. */
  targetChangeTime: z.string().optional(),
  /** Number of files (in deterministic depot-path order) already ingested in the in-flight sweep. */
  filesOffset: z.number().int().nonnegative().optional(),
});
export type PerforceCheckpoint = z.infer<typeof PerforceCheckpointSchema>;

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
  WebCrawlerConfigSchema,
  PerforceConfigSchema,
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
  WebCrawlerCheckpointSchema,
  PerforceCheckpointSchema,
]);
export type ConnectorCheckpoint = z.infer<typeof ConnectorCheckpointSchema>;

// ===== Sync Types =====

/**
 * The audience of a single document as extracted from the source system, used
 * by the permission-sync pass to build the per-document ACL:
 * - `users` — upstream principals resolved to emails (→ `user_email:` tokens)
 * - `groups` — upstream group ids (→ namespaced `group:<source>_<id>` tokens)
 * - `isPublic` — visible to everyone in the org (→ `org:*`)
 *
 * Empty permissions (no users, no groups, not public) ⇒ empty ACL ⇒ fail-closed
 * (only admins, who bypass the ACL, can retrieve the document).
 */
export interface DocumentPermissions {
  users?: string[];
  groups?: string[];
  isPublic?: boolean;
}

export interface ConnectorDocument {
  id: string;
  title: string;
  content: string;
  sourceUrl?: string;
  metadata: Record<string, unknown>;
  updatedAt?: Date;
  /** Access control permissions extracted from the source system */
  permissions?: DocumentPermissions;
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

// ===== Permission Sync Types =====

/** A lean reference to one already-ingested document (content-sync output). */
export interface IngestedDocumentRef {
  sourceId: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Keyset-paginated read-back of a connector's already-ingested documents,
 * injected into the permission-sync hooks by the pass. Container-scoped
 * connectors (GitHub: repo → its docs) use this to tag every document in a
 * container with the container's once-resolved audience — a deliberate,
 * documented read of content-sync output, O(page) memory. Per-item connectors
 * (Jira/Confluence) that re-enumerate upstream can ignore it.
 */
export type ReadIngestedDocuments = (args: {
  /** JSONB equality filter on `kb_documents.metadata` (e.g. `{ repo: "o/r" }`). */
  metadataFilter?: Record<string, string>;
  /** Keyset cursor: return only rows with id > afterId (ascending by id). */
  afterId?: string | null;
  limit: number;
}) => Promise<{ documents: IngestedDocumentRef[]; nextAfterId: string | null }>;

/** Shared input for the permission-sync extraction hooks (§1 of the plan). */
export interface PermissionSyncParams {
  config: Record<string, unknown>;
  credentials: ConnectorCredentials;
  /**
   * Opaque resume cursor from a prior interrupted run of the same generation,
   * or null on a fresh enumeration. Connectors treat it as their own
   * stable-ordered position marker (e.g. last page id / issue key / repo).
   */
  cursor: string | null;
  /** Read-back of already-ingested docs (see ReadIngestedDocuments). */
  readIngestedDocuments: ReadIngestedDocuments;
  /**
   * Admin mapping lookup (see `ResolveMappedEmail`), injected by the pass.
   */
  resolveMappedEmail?: ResolveMappedEmail;
  /**
   * Delta-pass scoping: when set, `syncPermissionSnapshot` enumerates ONLY
   * these top-level containers (the probe's dirty set). Absent on full passes.
   */
  scope?: { containerKeys: string[] };
  /**
   * True only on a MANUAL pass ("Sync Permissions Now"): cross-pass identity
   * caches are bypassed on read and rewritten, so an upstream email/profile
   * change (e.g. a member making their GitHub email public) is picked up
   * immediately rather than waiting out the cache TTL.
   *
   * Deliberately not every full pass. Resolving an identity is one rate-limited
   * upstream request per account, and a connector without a delta mode runs
   * every pass as a full one — so keying this off the mode meant its identity
   * cache never served a single read, and every pass re-fetched every member's
   * profile. Scheduled passes read the caches, whose 24h TTL bounds identity
   * staleness to what a daily full reconcile bounded it to anyway.
   */
  refreshIdentities?: boolean;
}

/**
 * Upstream account id → the email access control should materialize for it,
 * per the admin's manual member mapping (Permissions tab), or null when the
 * account is unmapped. Injected by the pass (preloaded, synchronous, no IO).
 * Connectors consult it FIRST in their principal-email resolution — the
 * mapping takes precedence over upstream email matching — so a DIRECT grant
 * (role actor, user grant, reporter/assignee) to an account whose upstream
 * email is hidden materializes as the mapped user's email instead of being
 * silently dropped.
 */
export type ResolveMappedEmail = (externalAccountId: string) => string | null;

/**
 * Opaque per-connector permission-sync probe state (audit-log cursors, config
 * fingerprints, last full-reconcile timestamp). Written and interpreted only
 * by the connector's own probe hook + the pass scheduler.
 */
export const PermissionSyncStateSchema = z.record(z.string(), z.unknown());
export type PermissionSyncState = z.infer<typeof PermissionSyncStateSchema>;

/**
 * Result of a delta-pass change probe (`probePermissionChanges`): what — if
 * anything — drifted upstream since `state` was recorded. `nextState` is
 * persisted by the pass ONLY on success, so an interrupted pass re-probes
 * from the same cursors (changes are never lost, at worst re-observed).
 *
 * Probes scope DOCUMENT re-enumeration only. Container audiences and group
 * memberships are re-verified directly on every delta pass (see
 * `refreshContainerAudiences` / `syncGroups`), never inferred from a probe:
 * inference from audit events proved lossy in production — records ingest
 * minutes late and slide out of cursor windows, and event wording is
 * asymmetric (a Jira project-access grant is audited as "Project roles
 * changed", the matching revocation as "User removed from project"). A
 * missed revocation stays fail-OPEN until the daily full reconcile, which is
 * the one direction this system must never err in.
 */
export interface PermissionProbeResult {
  /** Top-level container keys whose document assignments must be re-enumerated. */
  dirtyContainerKeys: string[];
  /**
   * The probe cannot scope the change — promote to a full reconcile. Reserved
   * for document→container ASSIGNMENT drift invisible to content-modified
   * windows (e.g. a Confluence restriction edit, which moves pages between
   * containers without bumping lastmodified) and for the first cursor-less
   * probe.
   */
  fullRequired: boolean;
  /** Next probe cursors/fingerprints to persist on success. */
  nextState: PermissionSyncState;
}

/**
 * One yield of `syncPermissionSnapshot` — a permission pass's single upstream
 * enumeration, interleaving CONTAINER audiences and per-DOCUMENT assignments.
 *
 * A container is the audience-sharing unit: top-level (`space:DEV`,
 * `project:ENG`, `repo:org/name`) or an exception nested under one, keyed
 * `<parent>/<child>` (`space:DEV/page:12345`, `project:ENG/level:10001`) so
 * per-container document scans can range over a top-level prefix. A document
 * assignment binds one document (`sourceId` MUST byte-match content-sync's
 * `kb_documents.sourceId`) to its container; `exceptionUsers` are principals
 * granted ON TOP of the container audience (e.g. a Jira issue's
 * reporter/assignee when the scheme grants them browse).
 *
 * Ordering contract:
 * - Yields are grouped by top-level container, and top-level container keys
 *   ascend in string order (the resume cursor is monotonic).
 * - `cursor` on every yield is the CURRENT top-level container key: a cursor
 *   change tells the pass the previous container's enumeration is complete,
 *   unlocking its fail-close set-diff.
 * - A container's yield precedes the document assignments that reference it.
 * - On resume, top-level containers with keys strictly below `params.cursor`
 *   are skipped; the cursor container is re-enumerated (idempotent).
 *
 * `fingerprint`, when cheaply available (audience hash, upstream ETag), is
 * stored on the container row for delta-pass change probes.
 */
export type PermissionSnapshotYield =
  | {
      kind: "container";
      containerKey: string;
      permissions: DocumentPermissions;
      fingerprint?: string | null;
      /**
       * The connector could NOT read this container's permissions upstream, so
       * `permissions` is the fail-closed empty audience rather than an observed
       * one. Set it whenever the audience is empty because a lookup failed —
       * never when upstream genuinely grants nobody. An empty audience hides
       * every document in the container, and the two causes are
       * indistinguishable from the outside, so the pass counts these into
       * `containerAudienceFailures` and an admin can tell "nobody has access"
       * from "we could not find out who has access".
       */
      audienceResolutionFailed?: boolean;
      cursor: string;
    }
  | {
      kind: "document";
      sourceId: string;
      containerKey: string;
      exceptionUsers?: string[];
      cursor: string;
    };

/**
 * One upstream group member. EVERY member is yielded, whether or not the
 * upstream exposes their email — `email` is null when hidden (the member is
 * then recorded fail-closed and surfaced to admins as unresolvable, instead of
 * silently dropped).
 */
export interface GroupMemberYield {
  /** Stable upstream principal id (Jira/Confluence accountId, GitHub login). */
  accountId: string;
  displayName: string | null;
  email: string | null;
  /**
   * Upstream account classification as the source reports it (Atlassian:
   * "atlassian" | "app" | "customer"). Null when the source has no notion of
   * it. "app" members are add-on/bot accounts that never resolve to a user —
   * admin stats separate them from genuinely unresolvable humans.
   */
  accountType?: string | null;
}

/**
 * One upstream group expanded to its members, yielded by `syncGroups`.
 * `groupId` MUST byte-match the id encoded in the document's
 * `group:<source>_<groupId>` token — the groupId data-contract.
 */
export interface GroupMembershipYield {
  groupId: string;
  members: GroupMemberYield[];
  cursor?: string;
}

// ===== Internal helpers =====

function ensureProtocol(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return `https://${url}`;
}

function hasAllowedWebCrawlerStartUrlScheme(url: string): boolean {
  if (/^https?:\/\//i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return /^(?:localhost|[a-z0-9.-]*\.[a-z0-9.-]+):\d+(?:[/?#]|$)/i.test(url);
  }
  return true;
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function stripDepotPathSuffix(path: string): string {
  let normalized = path.trim();
  if (normalized.endsWith("/...")) {
    normalized = normalized.slice(0, -"/...".length);
  }
  return normalized.replace(/\/+$/, "");
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

  // ===== Permission sync (optional; default-off, see BaseConnector) =====

  /**
   * Whether this connector implements the permission-sync hooks below. Default
   * `false`; overridden `true` by connectors that populate document audiences.
   * Adding permission sync to a connector = set this flag + implement the two
   * generators. Nothing else in the core changes.
   */
  supportsPermissionSync: boolean;

  /**
   * Yield the pass's permission snapshot — container audiences interleaved
   * with per-document container assignments — WITHOUT re-downloading content.
   * Audiences are resolved once per container (repo / space / project) and
   * upstream requests are O(containers + corpus pages), never O(documents).
   * See `PermissionSnapshotYield` for the ordering contract.
   */
  syncPermissionSnapshot?(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield>;

  /**
   * Yield each upstream group expanded to its member emails (instance/org-wide).
   */
  syncGroups?(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield>;

  /**
   * Cheap change probe driving DELTA passes: given the cursors/fingerprints
   * recorded by the previous pass, report what drifted upstream (a handful of
   * requests — audit-log windows, delta queries — never a corpus scan). A
   * connector without this hook runs every pass as a full reconcile. A first
   * probe (null state) must return `fullRequired`.
   */
  probePermissionChanges?(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    state: PermissionSyncState | null;
  }): Promise<PermissionProbeResult>;

  /**
   * Re-resolve the audiences of already-known containers (the pass feeds the
   * stored container keys) WITHOUT enumerating documents — O(containers)
   * upstream requests, run on EVERY delta pass so upstream grants and
   * revocations land on the next pass unconditionally. Required for delta
   * passes: a connector with a probe but without this hook runs full every
   * time. A key the connector cannot (or must not) refresh without an
   * assignment reconcile is simply not yielded: its stored row stays
   * untouched for the periodic full reconcile (fail-closed in the safe
   * direction).
   */
  refreshContainerAudiences?(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    containerKeys: string[];
    resolveMappedEmail?: ResolveMappedEmail;
  }): AsyncGenerator<{
    containerKey: string;
    permissions: DocumentPermissions;
    fingerprint?: string | null;
    /** See `PermissionSnapshotYield` — an empty audience the connector could not read, not one upstream withheld. */
    audienceResolutionFailed?: boolean;
  }>;

  /**
   * Pure metadata→scope mapping for local adoption during DELTA passes: the
   * top-level container scope key (`project:ENG`, `space:DOCS`,
   * `repo:org/name`) whose enumeration covers a stored document, or null when
   * the metadata cannot place it. The probe sees only UPSTREAM drift, so a
   * document that is locally new but upstream old (crawl backfill, resumed
   * initial sync) never dirties a container; the pass uses this mapping to
   * pull unassigned documents' containers into the delta scope. Scoping only —
   * assignment still comes from the authoritative `syncPermissionSnapshot`
   * enumeration, so a stale metadata value can delay adoption but never
   * over-grant.
   */
  scopeKeyForDocument?(metadata: Record<string, unknown>): string | null;
}
