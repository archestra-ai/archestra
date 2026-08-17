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
const MFILES = z.literal("mfiles");
/** Internal: backs uploaded knowledge files. Never user-selectable. */
const FILE_UPLOAD = z.literal("file_upload");

const USER_SELECTABLE_CONNECTOR_TYPES = [
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
  MFILES,
] as const;

/**
 * What a user may ask the API to CREATE. `file_upload` is excluded on purpose:
 * it is an internal connector the knowledge-files page creates implicitly, at
 * most one per knowledge base, so accepting it from a client would break that
 * invariant and put an unconfigurable entry in the connector dialog.
 *
 * Read schemas use `ConnectorTypeSchema` below, which does include it — an
 * uploads-backed connector is a real row that has to be listable.
 */
export const UserSelectableConnectorTypeSchema = z.union(
  USER_SELECTABLE_CONNECTOR_TYPES,
);
export type UserSelectableConnectorType = z.infer<
  typeof UserSelectableConnectorTypeSchema
>;

export const ConnectorTypeSchema = z.union([
  ...USER_SELECTABLE_CONNECTOR_TYPES,
  FILE_UPLOAD,
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
  // Ran cleanly and indexed nothing, with nothing indexed previously either.
  // Distinct from `success` because it almost always means the connector is
  // pointed somewhere it cannot see: nothing shared with the identity it
  // authenticates as, a folder or project filter aimed at something invisible
  // to it, or a file-type filter that excludes every file found. A green tick
  // on that is how a connector silently indexes nothing for weeks.
  "no_documents",
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
  // Google OAuth credentials for a Drive connector in `oauth` mode. The client
  // the token was issued to travels with the token because refreshing needs
  // all three: Google mints a new access token only for the same client.
  // `refreshToken` is absent until the authorization-code flow completes, which
  // is what "created but not yet connected" looks like on disk.
  googleOAuth: z
    .object({
      clientId: z.string(),
      clientSecret: z.string(),
      refreshToken: z.string().optional(),
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
  /**
   * Repository folders to index when `includeRepositoryFiles` is on. Each entry
   * is a path relative to the repository root (`docs`, `packages/api/src`); a
   * file matches when it sits at or under one of them. Empty/absent means the
   * whole repository, which is the pre-existing behaviour.
   */
  includePaths: z.array(z.string()).optional(),
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
  includeKnowledgeArticles: z.boolean().optional(),
  states: z.array(z.string()).optional(),
  assignmentGroups: z.array(z.string()).optional(),
  /**
   * Auto-sync permissions: per-table extra audience of ServiceNow role names
   * (e.g. `{ "incident": ["itil"] }`) granted read on every synced record of
   * that table, rostered from `sys_user_has_role`. Without an entry a table's
   * records are visible only to their participants (assignment-group members
   * and the referenced users).
   */
  roleAudiences: z.record(z.string(), z.array(z.string())).optional(),
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

/**
 * Which identity the Drive client acts as. Chosen deliberately rather than
 * inferred from whether the stored credential happens to parse as JSON:
 *
 * - `service_account` — a service-account key on its own. The connector sees
 *   exactly what somebody remembered to share with the key's email address.
 * - `service_account_delegated` — the same key with domain-wide delegation, so
 *   it can impersonate users in the Workspace domain. Coverage follows the
 *   organization instead of a manual share list.
 * - `oauth` — one person's own Drive, via the authorization-code flow.
 */
export const GoogleDriveAuthModeSchema = z.enum([
  "service_account",
  "service_account_delegated",
  "oauth",
]);
export type GoogleDriveAuthMode = z.infer<typeof GoogleDriveAuthModeSchema>;

export const GoogleDriveConfigSchema = z.object({
  type: GDRIVE,
  /**
   * Absent on connectors created before auth modes existed. Those keep the old
   * behavior — a credential that parses as JSON is a service-account key, and
   * anything else is a bare access token — so an upgrade does not change which
   * identity an existing connector syncs as.
   */
  authMode: GoogleDriveAuthModeSchema.optional(),
  /** Workspace user the service account impersonates in delegated mode. */
  delegatedAdminEmail: z.string().optional(),
  /**
   * Google account the OAuth flow last connected, for display. Overwritten
   * from the token response on every (re)connect, so it cannot drift into
   * claiming an account that is not the one syncing.
   */
  connectedAccountEmail: z.string().optional(),
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
  /**
   * Domain-wide sync progress. The pass walks the domain's shared drives and
   * users one at a time, so an interrupted run has to know where it got to —
   * without this it would restart at the first target every time and a domain
   * bigger than one run could never finish.
   *
   * Progress is a count into the ordered target list, not the list of finished
   * targets: a domain of twenty thousand identities would otherwise write a
   * list that size into this checkpoint on every batch. `domainTargetsFingerprint`
   * is what makes the count meaningful — when the domain's membership changes
   * the count refers to different targets, so the pass starts over rather than
   * skipping ones it never visited.
   *
   * `domainSyncStartedAt` stamps the pass the count belongs to; when a pass
   * completes, both are cleared and `lastSyncedAt` advances to it.
   */
  domainTargetsCompleted: z.number().int().nonnegative().optional(),
  domainTargetsFingerprint: z.string().optional(),
  domainSyncStartedAt: z.string().optional(),
  /**
   * Targets a pass could not read — an account with no Drive licence, a shared
   * drive with no reachable member, a request that hit a rate limit. The next
   * pass crawls these in full: everything that existed while they were
   * unreachable is older than the cursor, so an incremental query would never
   * look at it again.
   */
  domainFullCrawlTargets: z.array(z.string()).optional(),
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
  /**
   * Optional override for the wire-protocol address of the Perforce server
   * (`[ssl:]host:port`) that permission sync's in-cluster p4 shim dials.
   *
   * Normally left unset: `p4 webserver` is served by the p4d process itself,
   * so the wire address is derived from `serverUrl`'s host at p4d's default
   * port and then verified by probing it from the pod (both transports — the
   * `ssl:` prefix is discovered, not configured). Set this only when the REST
   * endpoint is genuinely not the p4d host, e.g. an ingress fronting the web
   * server alone. Permission sync additionally needs `adminUsername` and the
   * admin password in the credential `adminApiKey` field.
   */
  p4Port: z
    .string()
    .regex(/^(ssl:)?[A-Za-z0-9_.[\]-]+:\d{1,5}$/, {
      message: 'p4Port must look like "host:1666" or "ssl:host:1666"',
    })
    .optional(),
  /**
   * Admin-level Perforce user for permission sync. Reading the full
   * protections table (`p4 protects -a`) requires super access, or admin with
   * the `dm.protects.allow.admin=1` configurable.
   */
  adminUsername: z.string().min(1).max(256).optional(),
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

// ===== M-Files Config & Checkpoint =====

export const MFilesConfigSchema = z.object({
  type: MFILES,
  /** M-Files Classic Web base URL. The connector appends /REST itself. */
  baseUrl: connectorUrlSchema,
  /** Vault GUID, normally in {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx} form. */
  vaultGuid: z
    .string()
    .regex(
      /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i,
      {
        message:
          "Vault GUID must use {xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx} format",
      },
    ),
  /** Headless OAuth application accounts are preferred; absent means the legacy password-token mode. */
  authMethod: z
    .enum(["oauth_client_credentials", "mfiles_password_token"])
    .optional(),
  /** OAuth token endpoint owned by the configured identity provider. */
  oauthTokenEndpoint: connectorUrlSchema.optional(),
  /** Space-delimited OAuth scopes (for Entra ID this is normally `<resource>/.default`). */
  oauthScope: z.string().min(1).optional(),
  /** OAuth resource/audience for providers that use `resource` instead of `scope`. */
  oauthResource: z.string().min(1).optional(),
  /** Exact M-Files authentication provider name sent in X-AuthConfig. */
  oauthAuthConfig: z.string().min(1).optional(),
  /** Scope containing the authentication provider, sent in X-AuthConfigScope. */
  oauthAuthConfigScope: z.string().min(1).optional(),
  /** M-Files application-account username selected through X-ExtraAuthData. */
  oauthAccountName: z.string().min(1).optional(),
  /** Use the ID token only when the M-Files provider requires it. */
  oauthUseIdToken: z.boolean().optional(),
  /** How the OAuth client authenticates to the token endpoint. */
  oauthClientAuthMethod: z
    .enum(["client_secret_post", "client_secret_basic"])
    .optional(),
  /** Windows domain for domain-authenticated M-Files accounts. */
  domain: z.string().optional(),
  /** M-Files object types to ingest. Built-in Documents is type 0. */
  objectTypeIds: z.array(z.number().int().nonnegative()).min(1).optional(),
  /** Documents emitted per Archestra connector batch. */
  batchSize: z.number().int().min(1).max(500).optional(),
  /**
   * VAF extension method that exposes effective ACLs and group membership.
   * MFWS itself intentionally has no documented ACL/users/groups resources.
   */
  permissionExtensionMethod: z.string().min(1).optional(),
});
export type MFilesConfig = z.infer<typeof MFilesConfigSchema>;

export const MFilesCheckpointSchema = z.object({
  type: MFILES,
  lastSyncedAt: z.string().optional(),
  /** Durable add-on-journal cursor committed only after its page mutations. */
  changeCursor: z.string().optional(),
  /** Baseline state is retained across time-boxed continuation runs. */
  baselineCursor: z.string().nullable().optional(),
  baselineHeadCursor: z.string().optional(),
  baselineGeneration: z.string().uuid().optional(),
  addOnInstanceId: z.string().uuid().optional(),
  addOnVersion: z.string().optional(),
  configFingerprint: z.string().optional(),
});
export type MFilesCheckpoint = z.infer<typeof MFilesCheckpointSchema>;

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
  MFilesConfigSchema,
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
  MFilesCheckpointSchema,
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
  /**
   * Metadata keys used only for sync bookkeeping. They are persisted but do
   * not change the content hash or force re-chunking when their values rotate.
   */
  operationalMetadataKeys?: string[];
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
  /**
   * True when the fallback omitted the top-level document rather than merely
   * degrading an optional sub-resource such as comments. These failures must
   * make the run visible as completed-with-errors while preserving any
   * last-known-good indexed copy.
   */
  itemUnavailable?: boolean;
  /**
   * Source id that can resolve this provisional failure later in the same
   * run. Domain-wide connectors may see the same source through another
   * identity; a later document with this id cancels the unavailable-item
   * error instead of double-counting a source that was ultimately ingested.
   */
  recoverySourceId?: string;
}

/**
 * Machine-readable classification of a skipped item. `no_extractable_text`
 * marks documents that were found but yielded nothing indexable (scanned PDF
 * with no text layer, unparseable or empty file, oversized image);
 * `unsupported_type` distinguishes file-filter guidance from unrelated
 * uncategorized skips. Transient fetch/export failures must use `failures`, not
 * this definitive category. The no-text subset is counted separately on the
 * run so silent data loss is visible (issue #7157).
 */
export type ConnectorSkipCategory = "no_extractable_text" | "unsupported_type";

export interface ConnectorItemSkipped {
  itemId: string | number;
  /**
   * Identity used by kb_documents.source_id. Defaults to String(itemId).
   * Connectors whose document IDs add a prefix (for example SharePoint site
   * pages) must provide it so a definitive skip can retire stale indexed text.
   */
  sourceId?: string;
  /**
   * Optional metadata scope that the existing kb_document must match before
   * retirement. Microsoft Graph drive-item IDs are only unique within a
   * user/drive, so raw IDs must never delete a sibling drive's row.
   */
  sourceScope?: {
    metadataField: "userId" | "driveId";
    value: string;
  };
  name: string;
  reason: string;
  category?: ConnectorSkipCategory;
}

export interface ConnectorSyncBatch {
  documents: ConnectorDocument[];
  failures?: ConnectorItemFailure[];
  skipped?: ConnectorItemSkipped[];
  /**
   * Successfully fetched source ids that must resolve later provisional
   * failures even when success preceded the failed attempt. Connectors only
   * need this when their normal cross-identity dedupe guarantee is degraded.
   */
  recoveredSourceIds?: string[];
  checkpoint: ConnectorCheckpoint;
  hasMore: boolean;
  /**
   * Completion-gated object/file reconciliation. After every listed document
   * in the batch ingests successfully, delete stored documents matching the
   * connector-scoped metadata filter whose source id is not in `seenSourceIds`.
   */
  reconcileScopes?: Array<{
    metadataFilter: Record<string, string>;
    seenSourceIds: string[];
  }>;
  /** Completion-gated full-baseline sweep using a connector-owned metadata generation. */
  completionSweep?: {
    metadataKey: string;
    generation: string;
  };
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

/**
 * Identifies the connector a sync is running for. Connectors that provision
 * their own infrastructure key it off this so one connector's workload — and
 * credentials — never share a runtime with another's, and so a settings change
 * can retire that runtime; see the Perforce shim (`k8s/p4-shim-runtime`), the
 * only current consumer.
 */
export interface ConnectorIdentity {
  /** Scopes the connector's own infrastructure. */
  connectorId: string;
  organizationId: string;
  /** The connector's environment, or null when it uses the default. */
  environmentId: string | null;
  secretId: string | null;
  /**
   * Version marker for the connector's stored credentials — the secret row's
   * `updatedAt`, not the connector's. It is the credential half of the
   * Perforce shim's rotation fingerprint, so a credential change retires the
   * pod without any secret material reaching a Kubernetes annotation.
   *
   * The connector's own `updatedAt` deliberately does NOT appear here: a
   * permission-sync pass writes that row on every run, so keying rotation off
   * it would restart the pod on every pass.
   */
  credentialVersion: string;
  /**
   * The run this work is being done under, when there is one.
   *
   * Carried on the identity so a connector that provisions its own runtime
   * (Perforce) can make that runtime refuse a caller whose run has since been
   * reclaimed — a worker resuming from a freeze would otherwise rebuild a pod
   * and drive upstream commands for a pass that ended. Absent for callers that
   * legitimately hold no run, such as Test Connection.
   */
  run?: { runId: string; epoch: number };
}

/** Shared input for the permission-sync extraction hooks (§1 of the plan). */
export interface PermissionSyncParams {
  config: Record<string, unknown>;
  credentials: ConnectorCredentials;
  /**
   * Optional so the hooks stay callable without it; a connector that needs it
   * must fail closed when it is absent rather than fall back to a shared or
   * install-wide resource.
   */
  identity?: ConnectorIdentity;
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
  scope?: { containerKeys: string[]; groupIds?: string[] };
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
  /** The dirty container list comes from an authoritative, gap-detecting source. */
  authoritativeAudienceScope?: boolean;
  /** Authoritative group ids whose membership/name must be re-read. */
  dirtyGroupIds?: string[];
  /** Groups authoritatively removed upstream. */
  deletedGroupIds?: string[];
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
  /** Human-readable source name. Authorization continues to use stable groupId. */
  name?: string | null;
  members: GroupMemberYield[];
  /** A failed expansion is an observed fail-closed empty group, not a clean empty group. */
  membershipResolutionFailed?: boolean;
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
    /** See {@link ConnectorTenant}; only connectors with per-tenant infrastructure read it. */
    identity?: ConnectorIdentity;
  }): Promise<{ success: boolean; error?: string }>;

  /** Estimate the total number of items to sync (for progress display). Returns null if unknown. */
  estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    embeddingInputModalities?: ModelInputModality[];
    embeddingAcceptedImageMimeTypes?: string[];
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
    /**
     * Image MIME types the embedding client accepts for the configured model
     * (undefined = no per-format restriction). Connectors ingest only image
     * formats in this list; the embedder skips other formats at embed time.
     */
    embeddingAcceptedImageMimeTypes?: string[];
  }): AsyncGenerator<ConnectorSyncBatch>;

  // ===== Permission sync (optional; default-off, see BaseConnector) =====

  /**
   * Whether this connector implements the permission-sync hooks below. Default
   * `false`; overridden `true` by connectors that populate document audiences.
   * Adding permission sync to a connector = set this flag + implement the two
   * generators. Nothing else in the core changes.
   */
  supportsPermissionSync: boolean;

  /** Abort the security pass if either group or permission reconciliation fails. */
  requiresAtomicSecuritySync?: boolean;

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
    identity?: ConnectorIdentity;
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
    identity?: ConnectorIdentity;
    containerKeys: string[];
    /** Read cached object-version metadata so the source can under-grant across revision races. */
    readIngestedDocuments: ReadIngestedDocuments;
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
