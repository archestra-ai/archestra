import {
  ClientType,
  createClient,
  type Version2Client,
  type Version3Client,
} from "jira.js";
import type pino from "pino";
import { LRUCacheManager } from "@/cache-manager";
import * as metrics from "@/observability/metrics";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorItemFailure,
  ConnectorSyncBatch,
  DocumentPermissions,
  GroupMembershipYield,
  GroupMemberYield,
  JiraCheckpoint,
  JiraConfig,
  PermissionProbeResult,
  PermissionSnapshotYield,
  PermissionSyncParams,
  PermissionSyncState,
  ResolveMappedEmail,
} from "@/types";
import { JiraConfigSchema } from "@/types";
import { AtlassianAdminEmailResolver } from "../atlassian-admin-email-resolver";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";
import { ConnectorIdentityCache } from "../identity-cache";

const BATCH_SIZE = 50;
// Permission enumeration fetches only three slim fields per issue, so it can
// take Jira Cloud's larger pages (~5× fewer requests over a corpus). Cloud
// only: its token pagination is clamp-safe (hasMore = !!nextPageToken), while
// the Server path's startAt math would silently truncate if the server
// clamped a page below the requested size.
const PERMISSION_ENUM_PAGE_SIZE_CLOUD = 250;
// Caps for the per-pass audience-resolution caches: sized so a normal site
// never evicts.
const PER_PROJECT_CACHE_MAX_SIZE = 2_000;
const ACCOUNT_EMAIL_CACHE_MAX_SIZE = 10_000;

/**
 * A project's static BROWSE_PROJECTS audience plus flags for the dynamic
 * per-issue holders (reporter / assignee), resolved once per project.
 */
type ProjectBrowseAudience = {
  base: DocumentPermissions;
  includeReporter: boolean;
  includeAssignee: boolean;
  /**
   * The permission scheme could not be READ (the call failed, or it came back
   * without grants), so `base` is the fail-closed empty audience rather than an
   * observed one. Distinguishes "nobody may browse this project" from "we never
   * found out who may" — identical from the outside, and only the second one is
   * a bug to chase.
   */
  resolutionFailed: boolean;
};

/** A container audience the connector resolved, and whether it could read it at all. */
type ResolvedAudience = {
  permissions: DocumentPermissions;
  resolutionFailed: boolean;
};
const SEARCH_FIELDS = [
  "summary",
  "description",
  "comment",
  "reporter",
  "assignee",
  "priority",
  "status",
  "labels",
  "issuetype",
  "updated",
  "project",
  "parent",
  "resolution",
  "resolutiondate",
  "created",
  "duedate",
];

export class JiraConnector extends BaseConnector {
  type = "jira" as const;
  supportsPermissionSync = true;

  // Per-pass caches so audience resolution is O(projects), not O(issues).
  // Size-bounded LRU (no TTL — instances are per-pass) so a pathologically
  // large site cannot grow them without limit; eviction only costs a re-fetch.
  private projectBrowseCache = new LRUCacheManager<ProjectBrowseAudience>({
    maxSize: PER_PROJECT_CACHE_MAX_SIZE,
    defaultTtl: 0,
  });
  private securitySchemeCache = new LRUCacheManager<number | null>({
    maxSize: PER_PROJECT_CACHE_MAX_SIZE,
    defaultTtl: 0,
  });
  private securityLevelCache = new LRUCacheManager<ResolvedAudience>({
    maxSize: PER_PROJECT_CACHE_MAX_SIZE,
    defaultTtl: 0,
  });
  private accountEmailCache = new LRUCacheManager<string | null>({
    maxSize: ACCOUNT_EMAIL_CACHE_MAX_SIZE,
    defaultTtl: 0,
  });
  /** applicationRole key (or "" = any logged-in user) → its site-access group names. */
  private applicationRoleGroupsCache = new LRUCacheManager<string[]>({
    maxSize: PER_PROJECT_CACHE_MAX_SIZE,
    defaultTtl: 0,
  });
  /**
   * Cloud-only fallback for emails the product API hides (set per permission
   * pass): the Atlassian admin APIs, reachable when the connector credential is
   * an org-admin API key. Null on Server/DC and outside permission passes.
   */
  private adminEmailResolver: AtlassianAdminEmailResolver | null = null;
  /**
   * Admin member-mapping lookup injected by the pass (see ResolveMappedEmail).
   * Consulted FIRST in principal-email resolution. Armed per permission pass.
   */
  private resolveMappedEmail: ResolveMappedEmail | null = null;
  /**
   * Cross-pass persistence behind `accountEmailCache`: account → email results
   * (including hidden-email negatives) survive the pass so the next run does
   * not re-probe every distinct principal. Armed per permission pass.
   */
  private persistentEmailCache: ConnectorIdentityCache<string | null> | null =
    null;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parseJiraConfig,
      label: "Jira",
      invalidConfigError:
        "Invalid Jira configuration: jiraBaseUrl (string) and isCloud (boolean) are required",
      extraChecks: (parsed) =>
        /^https?:\/\/.+/.test(parsed.jiraBaseUrl)
          ? null
          : "jiraBaseUrl must be a valid HTTP(S) URL",
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseJiraConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Jira configuration" };
    }

    return this.runConnectionTest({
      label: "Jira",
      probe: async () => {
        if (parsed.isCloud) {
          const client = createV3Client(parsed, params.credentials, this.log);
          await client.myself.getCurrentUser();
        } else {
          const client = createV2Client(parsed, params.credentials, this.log);
          await client.myself.getCurrentUser();
        }
      },
      errorContext: extractJiraErrorDetails,
    });
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseJiraConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as JiraCheckpoint | null) ?? {
        type: "jira" as const,
      };
      const jql = buildJql(parsed, checkpoint);

      this.log.info({ jql }, "Estimating total items");

      // Cloud removed the classic JQL search (the only totals-bearing search);
      // the sanctioned replacement for a count is the approximate-count
      // endpoint. Approximate is fine — this only feeds progress display.
      if (parsed.isCloud) {
        const client = createV3Client(parsed, params.credentials, this.log);
        const result = await client.issueSearch.countIssues({ jql });
        return result.count ?? null;
      }

      const client = createV2Client(parsed, params.credentials, this.log);
      const result = await client.issueSearch.searchForIssuesUsingJql({
        jql,
        fields: ["summary"],
        maxResults: 0,
      });
      return result.total ?? null;
    } catch (error) {
      this.log.warn(
        {
          error: extractErrorMessage(error),
          ...extractJiraErrorDetails(error),
        },
        "Failed to estimate total items",
      );
      return null;
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseJiraConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Jira configuration");
    }

    const checkpoint = (params.checkpoint as JiraCheckpoint | null) ?? {
      type: "jira" as const,
    };
    const jql = buildJql(parsed, checkpoint, params.startTime);

    this.log.info(
      {
        baseUrl: parsed.jiraBaseUrl,
        isCloud: parsed.isCloud,
        projectKey: parsed.projectKey,
        jql,
        checkpoint,
      },
      "Starting sync",
    );

    if (parsed.isCloud) {
      yield* this.syncCloud(parsed, params.credentials, jql, checkpoint);
    } else {
      yield* this.syncServer(parsed, params.credentials, jql, checkpoint);
    }
  }

  // ===== Private methods =====

  private async *syncCloud(
    config: JiraConfig,
    credentials: ConnectorCredentials,
    jql: string,
    checkpoint: JiraCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const client = createV3Client(config, credentials, this.log);
    let nextPageToken: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug({ batchIndex, nextPageToken }, "Fetching cloud batch");

        const searchResult =
          await client.issueSearch.searchForIssuesUsingJqlEnhancedSearchPost({
            jql,
            fields: SEARCH_FIELDS,
            nextPageToken,
            maxResults: BATCH_SIZE,
          });

        const issues = searchResult.issues ?? [];
        const documents = issuesToDocuments(issues, config);

        nextPageToken = searchResult.nextPageToken ?? undefined;
        hasMore = !!nextPageToken;

        this.log.info(
          {
            batchIndex,
            issueCount: issues.length,
            documentCount: documents.length,
            hasMore,
          },
          "Cloud batch fetched",
        );

        batchIndex++;
        yield buildBatch({
          documents,
          issues,
          failures: this.flushFailures(),
          checkpoint,
          hasMore,
        });
      } catch (error) {
        this.log.error(
          {
            batchIndex,
            host: config.jiraBaseUrl,
            error: extractErrorMessage(error),
            ...extractJiraErrorDetails(error),
          },
          "Cloud batch fetch failed",
        );
        throw error;
      }
    }
  }

  private async *syncServer(
    config: JiraConfig,
    credentials: ConnectorCredentials,
    jql: string,
    checkpoint: JiraCheckpoint,
  ): AsyncGenerator<ConnectorSyncBatch> {
    const client = createV2Client(config, credentials, this.log);
    let startAt = 0;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug({ batchIndex, startAt }, "Fetching server batch");

        const searchResult =
          await client.issueSearch.searchForIssuesUsingJqlPost({
            jql,
            fields: SEARCH_FIELDS,
            startAt,
            maxResults: BATCH_SIZE,
          });

        const issues = searchResult.issues ?? [];
        const documents = issuesToDocuments(issues, config);

        startAt += issues.length;
        hasMore =
          issues.length >= BATCH_SIZE &&
          startAt < (searchResult.total ?? startAt);

        this.log.info(
          {
            batchIndex,
            issueCount: issues.length,
            documentCount: documents.length,
            total: searchResult.total,
            hasMore,
          },
          "Server batch fetched",
        );

        batchIndex++;
        yield buildBatch({
          documents,
          issues,
          failures: this.flushFailures(),
          checkpoint,
          hasMore,
        });
      } catch (error) {
        this.log.error(
          {
            batchIndex,
            host: config.jiraBaseUrl,
            error: extractErrorMessage(error),
            ...extractJiraErrorDetails(error),
          },
          "Server batch fetch failed",
        );
        throw error;
      }
    }
  }

  // ===== Permission sync hooks =====

  /**
   * Project-scoped snapshot. Each project is one top-level container
   * `project:<KEY>` whose BROWSE_PROJECTS audience is resolved ONCE
   * (anyone/applicationRole → public, user → email, group → group id,
   * projectRole → role actors); issues carrying a security level land in a
   * nested `project:<KEY>/level:<levelId>` container resolved from the
   * level's members (the level OVERRIDES the project audience entirely).
   * Reporter/assignee browse grants stay per-issue `exceptionUsers`. Schemes,
   * levels, and emails are cached, so upstream calls are O(projects + roles +
   * levels + corpus pages), never O(issues). `cursor` is the project
   * container key: projects strictly before it are done; the cursor project
   * is re-processed (idempotent).
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseJiraConfig(params.config);
    if (!config) {
      throw new Error("Invalid Jira configuration for permission sync");
    }
    // biome-ignore lint/suspicious/noExplicitAny: jira.js@5.3.1 permission-API types are broken (see createV3Client)
    const client: any = config.isCloud
      ? createV3Client(config, params.credentials, this.log)
      : createV2Client(config, params.credentials, this.log);
    this.initAdminEmailResolver(
      config,
      params.credentials,
      params.refreshIdentities,
    );

    this.resolveMappedEmail = params.resolveMappedEmail ?? null;

    const scope = params.scope ? new Set(params.scope.containerKeys) : null;
    const projectKeys = await this.listCorpusProjectKeys(client, config);
    for (const projectKey of projectKeys) {
      if (scope && !scope.has(`project:${projectKey}`)) continue;
      if (params.cursor && `project:${projectKey}` < params.cursor) continue;
      yield* this.syncProjectSnapshot(client, config, projectKey);
    }
  }

  /**
   * Project keys holding corpus content, sorted so the resume cursor is
   * monotonic: the configured project list when one is set, else every
   * project the credential can see (a project whose corpus JQL matches
   * nothing still emits an empty container so its documents fail-close).
   */
  private async listCorpusProjectKeys(
    // biome-ignore lint/suspicious/noExplicitAny: jira.js client
    client: any,
    config: JiraConfig,
  ): Promise<string[]> {
    const configured = getProjectKeyList(config);
    if (configured.length > 0) return [...configured].sort();

    const keys: string[] = [];
    if (config.isCloud) {
      let startAt = 0;
      for (;;) {
        await this.rateLimit();
        const result = await client.projects.searchProjects({
          startAt,
          maxResults: 50,
        });
        // biome-ignore lint/suspicious/noExplicitAny: SDK project shape
        const values: any[] = result?.values ?? [];
        for (const project of values) {
          if (project?.key) keys.push(String(project.key));
        }
        startAt += values.length;
        if (startAt >= (result?.total ?? Infinity) || values.length === 0) {
          break;
        }
      }
    } else {
      await this.rateLimit();
      // biome-ignore lint/suspicious/noExplicitAny: SDK project shape
      const projects: any[] = (await client.projects.getAllProjects()) ?? [];
      for (const project of projects) {
        if (project?.key) keys.push(String(project.key));
      }
    }
    return keys.sort();
  }

  private async *syncProjectSnapshot(
    // biome-ignore lint/suspicious/noExplicitAny: jira.js client
    client: any,
    config: JiraConfig,
    projectKey: string,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const projectContainerKey = `project:${projectKey}`;
    const jql = buildJql(config, { type: "jira" }, undefined, [
      `project = "${projectKey}"`,
    ]);
    const fields = ["security", "reporter", "assignee"];

    let browse: ProjectBrowseAudience | null = null;
    let projectContainerEmitted = false;
    const emittedLevelContainers = new Set<string>();

    // Cloud paginates by an opaque nextPageToken; Server/DC by startAt.
    let nextPageToken: string | undefined;
    let startAt = 0;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();
      let issues: JiraIssue[];
      if (config.isCloud) {
        const result =
          await client.issueSearch.searchForIssuesUsingJqlEnhancedSearchPost({
            jql,
            fields,
            nextPageToken,
            maxResults: PERMISSION_ENUM_PAGE_SIZE_CLOUD,
          });
        issues = result.issues ?? [];
        nextPageToken = result.nextPageToken ?? undefined;
        hasMore = !!nextPageToken;
      } else {
        const result = await client.issueSearch.searchForIssuesUsingJqlPost({
          jql,
          fields,
          startAt,
          maxResults: BATCH_SIZE,
        });
        issues = result.issues ?? [];
        startAt += issues.length;
        hasMore =
          issues.length >= BATCH_SIZE && startAt < (result.total ?? startAt);
      }

      if (!projectContainerEmitted) {
        // An empty-corpus project emits a fail-closed container WITHOUT
        // resolving its audience (nothing references it — the pass only needs
        // the enumeration boundary to fail-close leftover documents).
        browse =
          issues.length > 0
            ? await this.resolveProjectBrowse(client, config, projectKey)
            : null;
        yield {
          kind: "container",
          containerKey: projectContainerKey,
          permissions: browse?.base ?? {
            isPublic: false,
            users: [],
            groups: [],
          },
          // An empty-corpus project is NOT a failure — its audience is
          // deliberately left unresolved because no document references it.
          audienceResolutionFailed: browse?.resolutionFailed ?? false,
          cursor: projectContainerKey,
        };
        projectContainerEmitted = true;
      }

      for (const issue of issues) {
        const security = issue.fields?.security;
        if (security?.id) {
          const levelContainerKey = `${projectContainerKey}/level:${String(security.id)}`;
          if (!emittedLevelContainers.has(levelContainerKey)) {
            // Fail-soft inside: an unresolvable level yields a fail-closed
            // audience for ITS issues only, never aborting the pass.
            const level = await this.resolveSecurityLevelMembers(
              client,
              config,
              projectKey,
              String(security.id),
            );
            yield {
              kind: "container",
              containerKey: levelContainerKey,
              permissions: level.permissions,
              audienceResolutionFailed: level.resolutionFailed,
              cursor: projectContainerKey,
            };
            emittedLevelContainers.add(levelContainerKey);
          }
          yield {
            kind: "document",
            sourceId: issue.key,
            containerKey: levelContainerKey,
            cursor: projectContainerKey,
          };
          continue;
        }

        // Upstream email first (automatic matching always wins — matches
        // resolveJiraEmail's precedence); the admin mapping is only the
        // fallback that keeps a hidden-email reporter/assignee from silently
        // losing the exception grant.
        const exceptionEmail = (person?: {
          accountId?: string;
          emailAddress?: string;
        }): string | null =>
          person?.emailAddress ??
          (person?.accountId
            ? (this.resolveMappedEmail?.(person.accountId) ?? null)
            : null);
        const exceptionUsers: string[] = [];
        const reporterEmail = browse?.includeReporter
          ? exceptionEmail(issue.fields?.reporter)
          : null;
        if (reporterEmail) exceptionUsers.push(reporterEmail);
        const assigneeEmail = browse?.includeAssignee
          ? exceptionEmail(issue.fields?.assignee)
          : null;
        if (assigneeEmail) exceptionUsers.push(assigneeEmail);
        yield {
          kind: "document",
          sourceId: issue.key,
          containerKey: projectContainerKey,
          ...(exceptionUsers.length > 0 ? { exceptionUsers } : {}),
          cursor: projectContainerKey,
        };
      }
    }
  }

  /**
   * Delta-pass change probe (a handful of requests, never a corpus scan):
   * JQL `updated >= <cursor>` (ids only) catches issue-level drift —
   * security-level edits, moves, new issues — mapped to project containers
   * via the issue-key prefix (project keys cannot contain dashes).
   *
   * Deliberately NO audit-log inference: audiences and group memberships are
   * re-verified directly on every delta pass (see PermissionProbeResult), so
   * nothing here promotes to a full reconcile besides a missing cursor. The
   * audit API proved lossy for this — asynchronous ingestion slid records out
   * of cursor windows, and revocations are worded unlike grants.
   */
  async probePermissionChanges(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    state: PermissionSyncState | null;
  }): Promise<PermissionProbeResult> {
    const config = parseJiraConfig(params.config);
    if (!config) {
      throw new Error("Invalid Jira configuration for permission probe");
    }
    // biome-ignore lint/suspicious/noExplicitAny: jira.js@5.3.1 permission-API types are broken
    const client: any = config.isCloud
      ? createV3Client(config, params.credentials, this.log)
      : createV2Client(config, params.credentials, this.log);

    const now = new Date().toISOString();
    const nextState: PermissionSyncState = { jqlCursor: now };
    const jqlCursor =
      typeof params.state?.jqlCursor === "string"
        ? params.state.jqlCursor
        : null;
    if (!jqlCursor) {
      // First probe: no cursor yet — the full pass establishes it.
      return { dirtyContainerKeys: [], fullRequired: true, nextState };
    }

    // Issue-level drift since the cursor, ids only (largest page sizes).
    const dirtyProjects = new Set<string>();
    const jql = buildJql(config, { type: "jira" }, undefined, [
      `updated >= "${formatJiraDateWithSafetyBuffer(jqlCursor)}"`,
    ]);
    let nextPageToken: string | undefined;
    let startAt = 0;
    let hasMore = true;
    while (hasMore) {
      await this.rateLimit();
      let issues: JiraIssue[];
      if (config.isCloud) {
        const result =
          await client.issueSearch.searchForIssuesUsingJqlEnhancedSearchPost({
            jql,
            fields: ["id"],
            nextPageToken,
            maxResults: 5000,
          });
        issues = result.issues ?? [];
        nextPageToken = result.nextPageToken ?? undefined;
        hasMore = !!nextPageToken;
      } else {
        const result = await client.issueSearch.searchForIssuesUsingJqlPost({
          jql,
          fields: ["id"],
          startAt,
          maxResults: 1000,
        });
        issues = result.issues ?? [];
        startAt += issues.length;
        hasMore = issues.length > 0 && startAt < (result.total ?? startAt);
      }
      for (const issue of issues) {
        const projectKey = String(issue.key ?? "").split("-")[0];
        if (projectKey) dirtyProjects.add(projectKey);
      }
    }

    return {
      dirtyContainerKeys: [...dirtyProjects]
        .sort()
        .map((key) => `project:${key}`),
      fullRequired: false,
      nextState,
    };
  }

  /**
   * Audience verification, run on every delta pass: re-resolve each
   * stored container's audience — `project:<KEY>` via the permission scheme's
   * BROWSE_PROJECTS grants, `project:<KEY>/level:<ID>` via the security
   * level's members — without enumerating a single issue. O(containers)
   * upstream requests; the per-pass scheme/level/role caches dedupe shared
   * lookups. Keys of an unknown shape are skipped (their stored row is left
   * for the periodic full reconcile).
   */
  async *refreshContainerAudiences(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    containerKeys: string[];
    resolveMappedEmail?: ResolveMappedEmail;
  }): AsyncGenerator<{
    containerKey: string;
    permissions: DocumentPermissions;
    fingerprint?: string | null;
    audienceResolutionFailed?: boolean;
  }> {
    const config = parseJiraConfig(params.config);
    if (!config) {
      throw new Error("Invalid Jira configuration for audience refresh");
    }
    // biome-ignore lint/suspicious/noExplicitAny: jira.js@5.3.1 permission-API types are broken (see createV3Client)
    const client: any = config.isCloud
      ? createV3Client(config, params.credentials, this.log)
      : createV2Client(config, params.credentials, this.log);
    this.initAdminEmailResolver(config, params.credentials);
    this.resolveMappedEmail = params.resolveMappedEmail ?? null;

    for (const containerKey of params.containerKeys) {
      const parsed = containerKey.match(/^project:([^/]+)(?:\/level:(.+))?$/);
      if (!parsed) continue;
      const [, projectKey, levelId] = parsed;
      if (levelId) {
        const level = await this.resolveSecurityLevelMembers(
          client,
          config,
          projectKey,
          levelId,
        );
        yield {
          containerKey,
          permissions: level.permissions,
          audienceResolutionFailed: level.resolutionFailed,
        };
      } else {
        const browse = await this.resolveProjectBrowse(
          client,
          config,
          projectKey,
        );
        yield {
          containerKey,
          permissions: browse.base,
          audienceResolutionFailed: browse.resolutionFailed,
        };
      }
    }
  }

  /**
   * Local-adoption scoping for delta passes: a stored issue document is
   * covered by its project's enumeration (content-sync writes
   * `metadata.project` = the project key). Scoping only — the project
   * enumeration resolves the authoritative assignment, including per-issue
   * security levels, so this can never over-grant.
   */
  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const project = metadata.project;
    return typeof project === "string" && project.length > 0
      ? `project:${project}`
      : null;
  }

  /** Groups → members; group id = the group name (matches grant holders). */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseJiraConfig(params.config);
    if (!config) {
      throw new Error("Invalid Jira configuration for permission sync");
    }
    // biome-ignore lint/suspicious/noExplicitAny: jira.js@5.3.1 permission-API types are broken
    const client: any = config.isCloud
      ? createV3Client(config, params.credentials, this.log)
      : createV2Client(config, params.credentials, this.log);
    this.initAdminEmailResolver(
      config,
      params.credentials,
      params.refreshIdentities,
    );

    let startAt = 0;
    for (;;) {
      await this.rateLimit();
      const result = await client.groups.bulkGetGroups({
        startAt,
        maxResults: 50,
      });
      // biome-ignore lint/suspicious/noExplicitAny: SDK group shape
      const groups: any[] = result.values ?? [];
      for (const group of groups) {
        // Per-group failure isolation: hidden system groups (e.g.
        // `atlassian-addons`) appear in the bulk listing but 404 on member
        // lookup — one such group must not abort the whole enumeration (which
        // would leave the snapshot empty and every group grant unresolvable).
        // A failed group yields no members: fail-closed for that group only.
        let members: GroupMemberYield[] = [];
        try {
          members = await this.resolveGroupMembers(client, {
            name: group.name,
            groupId: group.groupId,
          });
        } catch (error) {
          this.log.warn(
            { group: group.name, error: extractErrorMessage(error) },
            "Could not resolve Jira group members; skipping group (its grants stay fail-closed)",
          );
        }
        yield { groupId: group.name, members, cursor: group.name };
      }
      startAt += groups.length;
      if (startAt >= (result.total ?? Infinity) || groups.length === 0) break;
    }
  }

  private async resolveProjectBrowse(
    // biome-ignore lint/suspicious/noExplicitAny: jira.js client
    client: any,
    config: JiraConfig,
    projectKey: string,
  ): Promise<ProjectBrowseAudience> {
    const cached = this.projectBrowseCache.get(projectKey);
    if (cached) return cached;

    const acc: MutableAudience = {
      isPublic: false,
      users: [],
      groups: [],
      includeReporter: false,
      includeAssignee: false,
    };
    let resolutionFailed = false;
    try {
      await this.rateLimit();
      const scheme =
        await client.projectPermissionSchemes.getAssignedPermissionScheme({
          projectKeyOrId: projectKey,
          expand: "permissions",
        });
      let grants = scheme?.permissions;
      if (!grants && scheme?.id) {
        await this.rateLimit();
        const full = await client.permissionSchemes.getPermissionSchemeGrants({
          schemeId: scheme.id,
          expand: "permissions",
        });
        grants = full?.permissions;
      }
      if (!grants) {
        // Neither the assigned scheme nor the by-id fallback produced grants
        // (an expand the instance ignored, a scheme with no id to fall back on,
        // a shape we do not understand). Iterating `grants ?? []` over that
        // yields an empty audience that is indistinguishable from a project
        // nobody may browse — and hides the project's entire corpus. It is a
        // failure to READ the permissions, and it is reported as one.
        resolutionFailed = true;
        this.log.error(
          { projectKey, schemeId: scheme?.id ?? null },
          "Jira returned no BROWSE_PROJECTS grants for this project's permission scheme; every issue in the project is fail-closed for this pass",
        );
      }
      for (const grant of grants ?? []) {
        if (grant?.permission !== "BROWSE_PROJECTS") continue;
        await this.applyHolder(client, config, projectKey, grant.holder, acc);
      }
    } catch (error) {
      resolutionFailed = true;
      this.log.error(
        { projectKey, error: extractErrorMessage(error) },
        "Could not read the project's permission scheme; every issue in the project is fail-closed for this pass",
      );
    }

    const audience: ProjectBrowseAudience = {
      base: {
        isPublic: acc.isPublic,
        users: acc.users,
        groups: acc.groups,
      },
      includeReporter: acc.includeReporter,
      includeAssignee: acc.includeAssignee,
      resolutionFailed,
    };
    this.projectBrowseCache.set(projectKey, audience);
    return audience;
  }

  private async resolveSecurityLevelMembers(
    // biome-ignore lint/suspicious/noExplicitAny: jira.js client
    client: any,
    config: JiraConfig,
    projectKey: string,
    levelId: string,
  ): Promise<ResolvedAudience> {
    const schemeId = await this.resolveSecuritySchemeId(client, projectKey);
    if (schemeId === null) {
      // The scheme lookup already logged; the level's issues fail-close and the
      // pass counts it (rather than reading as "this level grants nobody").
      return { permissions: {}, resolutionFailed: true };
    }
    const cacheKey = `${schemeId}:${levelId}`;
    const cached = this.securityLevelCache.get(cacheKey);
    if (cached) return cached;

    const acc: MutableAudience = {
      isPublic: false,
      users: [],
      groups: [],
      includeReporter: false,
      includeAssignee: false,
    };
    let resolutionFailed = false;
    try {
      let startAt = 0;
      for (;;) {
        await this.rateLimit();
        const result =
          await client.issueSecurityLevel.getIssueSecurityLevelMembers({
            issueSecuritySchemeId: schemeId,
            issueSecurityLevelId: [Number(levelId)],
            expand: "all",
            startAt,
            maxResults: 50,
          });
        // biome-ignore lint/suspicious/noExplicitAny: SDK member shape
        const members: any[] = result?.values ?? [];
        for (const member of members) {
          await this.applyHolder(
            client,
            config,
            projectKey,
            member.holder,
            acc,
          );
        }
        startAt += members.length;
        if (startAt >= (result?.total ?? Infinity) || members.length === 0)
          break;
      }
    } catch (error) {
      resolutionFailed = true;
      this.log.error(
        { projectKey, levelId, error: extractErrorMessage(error) },
        "Could not read the issue security level's members; every issue at this level is fail-closed for this pass",
      );
    }

    const audience: ResolvedAudience = {
      permissions: {
        isPublic: acc.isPublic,
        users: acc.users,
        groups: acc.groups,
      },
      resolutionFailed,
    };
    this.securityLevelCache.set(cacheKey, audience);
    return audience;
  }

  private async resolveSecuritySchemeId(
    // biome-ignore lint/suspicious/noExplicitAny: jira.js client
    client: any,
    projectKey: string,
  ): Promise<number | null> {
    const cached = this.securitySchemeCache.get(projectKey);
    if (cached !== undefined) return cached;
    let schemeId: number | null = null;
    try {
      await this.rateLimit();
      const scheme =
        await client.projectPermissionSchemes.getProjectIssueSecurityScheme({
          projectKeyOrId: projectKey,
        });
      schemeId = typeof scheme?.id === "number" ? scheme.id : null;
    } catch (error) {
      this.log.error(
        { projectKey, error: extractErrorMessage(error) },
        "Could not read the project's issue-security scheme; every issue carrying a security level in it is fail-closed for this pass",
      );
    }
    this.securitySchemeCache.set(projectKey, schemeId);
    return schemeId;
  }

  /** Apply one permission/security holder to the accumulating audience. */
  private async applyHolder(
    // biome-ignore lint/suspicious/noExplicitAny: jira.js client
    client: any,
    config: JiraConfig,
    projectKey: string,
    // biome-ignore lint/suspicious/noExplicitAny: SDK holder shape
    holder: any,
    acc: MutableAudience,
  ): Promise<void> {
    if (!holder?.type) return;
    const identifier: string | undefined = holder.value ?? holder.parameter;
    switch (holder.type) {
      case "anyone":
        // "Anyone on the web" — genuinely anonymous access, so org-wide.
        acc.isPublic = true;
        break;
      case "applicationRole": {
        // "Any logged-in user" of the SITE — a specific, revocable set (the
        // application's access groups, e.g. `jira-users-<site>`), NOT the
        // whole Archestra org. Mapping this to `org:*` would over-grant: a
        // user removed from the site's access group upstream would keep
        // seeing the documents. Resolve to the role's group names instead;
        // membership then flows through the group snapshot like any group
        // grant (revocation = next pass sweeps their membership row).
        const groups = await this.resolveApplicationRoleGroups(
          client,
          holder.parameter ?? holder.value,
        );
        acc.groups.push(...groups);
        break;
      }
      case "reporter":
        acc.includeReporter = true;
        break;
      case "assignee":
        acc.includeAssignee = true;
        break;
      case "group":
      case "groupCustomField": {
        // Group holders must be keyed by group NAME to byte-match the membership
        // rows written by syncGroups/resolveGroupMemberEmails (keyed by group
        // name). On Jira Cloud `holder.value` is the group UUID and
        // `holder.parameter` is the name, so prefer `parameter`; Server/DC also
        // carries the name in `parameter`. Using `value` here would emit a
        // `group:jira_<uuid>` token no membership row ever matches — silently
        // denying every member of the group.
        const groupId: string | undefined = holder.parameter ?? holder.value;
        if (groupId) acc.groups.push(groupId);
        break;
      }
      case "user": {
        const email = await this.resolveJiraEmail(client, config, identifier);
        if (email) acc.users.push(email);
        else this.meterDroppedPrincipals(1);
        break;
      }
      case "projectRole": {
        if (!identifier) break;
        await this.applyProjectRoleActors(
          client,
          config,
          projectKey,
          Number(identifier),
          acc,
        );
        break;
      }
      // projectLead and other dynamic holders are not resolved (documented).
    }
  }

  private async applyProjectRoleActors(
    // biome-ignore lint/suspicious/noExplicitAny: jira.js client
    client: any,
    config: JiraConfig,
    projectKey: string,
    roleId: number,
    acc: MutableAudience,
  ): Promise<void> {
    try {
      await this.rateLimit();
      const role = await client.projectRoles.getProjectRole({
        projectIdOrKey: projectKey,
        id: roleId,
      });
      // biome-ignore lint/suspicious/noExplicitAny: SDK actor shape
      for (const actor of (role?.actors ?? []) as any[]) {
        if (actor?.actorGroup?.name) {
          acc.groups.push(actor.actorGroup.name);
        } else if (actor?.actorUser?.accountId) {
          const email = await this.resolveJiraEmail(
            client,
            config,
            actor.actorUser.accountId,
          );
          if (email) acc.users.push(email);
          else this.meterDroppedPrincipals(1);
        }
      }
    } catch (error) {
      this.log.debug(
        { projectKey, roleId, error: extractErrorMessage(error) },
        "Could not resolve project role actors",
      );
    }
  }

  /**
   * Resolve an `applicationRole` grant ("any logged-in user" of the site) to
   * the role's site-access group NAMES (e.g. `jira-users-<site>`), cached per
   * pass. An absent key means "any application" — the union across all roles.
   * On failure the grant resolves to no groups (fail-closed, logged) rather
   * than over-granting.
   */
  private async resolveApplicationRoleGroups(
    // biome-ignore lint/suspicious/noExplicitAny: jira.js client
    client: any,
    applicationKey: string | undefined,
  ): Promise<string[]> {
    const cacheKey = applicationKey ?? "";
    const cached = this.applicationRoleGroupsCache.get(cacheKey);
    if (cached) return cached;

    let groupNames: string[] = [];
    try {
      await this.rateLimit();
      // biome-ignore lint/suspicious/noExplicitAny: SDK role shape
      const roles: any[] = applicationKey
        ? [
            await client.applicationRoles.getApplicationRole({
              key: applicationKey,
            }),
          ]
        : ((await client.applicationRoles.getAllApplicationRoles()) ?? []);
      const names = new Set<string>();
      for (const role of roles) {
        // Prefer groupDetails (stable name+id pairs); the legacy `groups`
        // field carries names on Server/DC and is the fallback.
        // biome-ignore lint/suspicious/noExplicitAny: SDK group shape
        const details: any[] = role?.groupDetails ?? [];
        if (details.length > 0) {
          for (const group of details) {
            if (group?.name) names.add(group.name);
          }
        } else {
          for (const name of role?.groups ?? []) {
            if (typeof name === "string" && name) names.add(name);
          }
        }
      }
      groupNames = [...names];
    } catch (error) {
      this.log.warn(
        { applicationKey, error: extractErrorMessage(error) },
        "Could not resolve Jira application-role groups; the grant stays fail-closed",
      );
    }
    this.applicationRoleGroupsCache.set(cacheKey, groupNames);
    return groupNames;
  }

  /**
   * Meter upstream principals dropped because their email could not be resolved
   * (Cloud email privacy). Fail-closed under-grant — surfaced so admins see the
   * coverage gap rather than silently narrowing an audience.
   */
  private meterDroppedPrincipals(count: number): void {
    if (count <= 0) return;
    this.log.debug(
      { count, connectorType: this.type },
      "Dropped Jira principals with no resolvable email (fail-closed)",
    );
    metrics.rag.reportPermissionSyncDroppedPrincipals({
      connectorType: this.type,
      reason: "no_email",
      count,
    });
  }

  /**
   * Expand a group to EVERY member — including members whose email Jira hides
   * (Cloud only exposes another user's email when their profile email
   * visibility is "Anyone"; the caller's admin role does not unlock it). A
   * hidden email yields `email: null` so the principal is still recorded.
   */
  private async resolveGroupMembers(
    // biome-ignore lint/suspicious/noExplicitAny: jira.js client
    client: any,
    group: { name: string; groupId?: string },
  ): Promise<GroupMemberYield[]> {
    const members: GroupMemberYield[] = [];
    let startAt = 0;
    for (;;) {
      await this.rateLimit();
      // Prefer the immutable groupId for the member lookup (names are
      // rename-able and some name lookups 404); the NAME stays the snapshot /
      // token key — see the group data contract.
      const result = await client.groups.getUsersFromGroup({
        ...(group.groupId
          ? { groupId: group.groupId }
          : { groupname: group.name }),
        startAt,
        maxResults: 50,
      });
      // biome-ignore lint/suspicious/noExplicitAny: SDK user shape
      const users: any[] = result?.values ?? [];
      for (const user of users) {
        // Cloud has accountId; Server/DC has username/key instead.
        const accountId =
          user?.accountId ?? user?.name ?? user?.key ?? user?.emailAddress;
        if (!accountId) continue; // no stable identity at all — nothing to record
        let email: string | null = user?.emailAddress ?? null;
        // Cloud hides the email from the product API for most accounts; the
        // admin APIs (org-admin API key credential) still resolve managed ones.
        if (!email && user?.accountId && this.adminEmailResolver) {
          email = await this.adminEmailResolver.resolveEmail(
            String(user.accountId),
          );
        }
        members.push({
          accountId: String(accountId),
          displayName: user?.displayName ?? null,
          email,
          // Cloud reports "atlassian" | "app" | "customer"; Server/DC omits it.
          accountType: user?.accountType ?? null,
        });
      }
      startAt += users.length;
      if (startAt >= (result?.total ?? Infinity) || users.length === 0) break;
    }
    return members;
  }

  /**
   * Resolve a Jira accountId/username to an email. Cloud largely hides emails
   * (privacy) — an unresolved principal is fail-closed (documented limitation).
   */
  private async resolveJiraEmail(
    // biome-ignore lint/suspicious/noExplicitAny: jira.js client
    client: any,
    config: JiraConfig,
    identifier: string | undefined,
  ): Promise<string | null> {
    if (!identifier) return null;
    // The upstream email always wins (automatic matching takes precedence —
    // same contract as the query-time group join). The admin mapping is only
    // the fallback that keeps a directly-granted account with a hidden
    // upstream email from being dropped from the audience.
    const mapped = this.resolveMappedEmail?.(identifier) ?? null;
    const cached = this.accountEmailCache.get(identifier);
    if (cached !== undefined) return cached ?? mapped;
    const persisted = await this.persistentEmailCache?.get(identifier);
    if (persisted !== undefined) {
      this.accountEmailCache.set(identifier, persisted);
      return persisted ?? mapped;
    }
    let email: string | null = null;
    try {
      await this.rateLimit();
      const params = config.isCloud
        ? { accountId: identifier }
        : { username: identifier };
      const user = await client.users.getUser(params);
      email = user?.emailAddress ?? null;
    } catch (error) {
      this.log.debug(
        { identifier, error: extractErrorMessage(error) },
        "Could not resolve Jira user email",
      );
    }
    // Cloud hides the email from the product API for most accounts; the admin
    // APIs (org-admin API key credential) still resolve managed accounts.
    if (!email && config.isCloud && this.adminEmailResolver) {
      email = await this.adminEmailResolver.resolveEmail(identifier);
    }
    this.accountEmailCache.set(identifier, email);
    await this.persistentEmailCache?.set(identifier, email);
    return email ?? mapped;
  }

  /**
   * Arm the per-pass identity helpers: the Cloud-only admin-API email fallback
   * (Server/DC returns emails to admin credentials directly; a fresh resolver
   * per pass keeps its directory snapshot as fresh as the pass itself) and the
   * cross-pass persistent email cache.
   */
  private initAdminEmailResolver(
    config: JiraConfig,
    credentials: ConnectorCredentials,
    refresh?: boolean,
  ): void {
    // The dedicated org-admin API key unlocks the admin APIs; the product
    // apiToken is only a long-shot fallback bearer (the admin APIs reject
    // plain user tokens and the resolver disables itself on the first
    // 401/403).
    const adminBearerKey = credentials.adminApiKey ?? credentials.apiToken;
    this.adminEmailResolver =
      config.isCloud && adminBearerKey
        ? new AtlassianAdminEmailResolver({
            apiKey: adminBearerKey,
            log: this.log,
            rateLimit: () => this.rateLimit(),
          })
        : null;
    this.persistentEmailCache = new ConnectorIdentityCache<string | null>({
      namespace: "jira-email",
      host: config.jiraBaseUrl,
      credentials,
      refresh,
    });
  }
}

// biome-ignore lint/suspicious/noExplicitAny: SDK issue shape
type JiraIssue = { key: string; fields?: any };

/** Mutable accumulator used while folding grants/holders into an audience. */
type MutableAudience = {
  isPublic: boolean;
  users: string[];
  groups: string[];
  includeReporter: boolean;
  includeAssignee: boolean;
};

// ===== Module-level helpers =====

function createV3Client(
  config: JiraConfig,
  credentials: ConnectorCredentials,
  log: pino.Logger,
): Version3Client {
  // @ts-expect-error jira.js@5.3.1 overload resolution broken: private 'client' property intersects to 'never'
  return createClient(ClientType.Version3, {
    host: config.jiraBaseUrl.replace(/\/+$/, ""),
    authentication: {
      basic: {
        email: credentials.email,
        apiToken: credentials.apiToken,
      },
    },
    middlewares: buildJiraMiddlewares(log),
  }) as unknown as Version3Client;
}

function createV2Client(
  config: JiraConfig,
  credentials: ConnectorCredentials,
  log: pino.Logger,
): Version2Client {
  return createClient(ClientType.Version2, {
    host: config.jiraBaseUrl.replace(/\/+$/, ""),
    noCheckAtlassianToken: true,
    authentication: credentials.email
      ? { basic: { email: credentials.email, apiToken: credentials.apiToken } }
      : { oauth2: { accessToken: credentials.apiToken } },
    middlewares: buildJiraMiddlewares(log),
  }) as unknown as Version2Client;
}

function buildJiraMiddlewares(log: pino.Logger) {
  return {
    onError: (error: unknown) => {
      // biome-ignore lint/suspicious/noExplicitAny: Axios error shape
      const err = error as any;
      // jira.js wraps axios errors into HttpException: the original axios error
      // (with its request config) is at `cause`, and `response` is a plain
      // {status, data, ...} object whose `data` carries Jira's error body — the
      // actionable detail ("errorMessages"). Surface both.
      const requestConfig =
        err?.config ?? err?.cause?.config ?? err?.response?.config;
      const detail = err?.response?.data;
      log.debug(
        {
          status: err?.response?.status,
          method: requestConfig?.method?.toUpperCase(),
          url: requestConfig?.url,
          detail:
            detail === undefined
              ? undefined
              : JSON.stringify(detail).slice(0, 300),
          error: err?.message ?? String(error),
        },
        "HTTP error",
      );
    },
    onResponse: (response: unknown) => {
      // biome-ignore lint/suspicious/noExplicitAny: Axios response shape
      const res = response as any;
      log.debug(
        {
          status: res?.status,
          method: res?.config?.method?.toUpperCase(),
          url: res?.config?.url,
        },
        "HTTP response",
      );
    },
  };
}

function issuesToDocuments(
  // biome-ignore lint/suspicious/noExplicitAny: SDK issue types vary between v2/v3
  issues: any[],
  config: JiraConfig,
): ConnectorDocument[] {
  const documents: ConnectorDocument[] = [];
  for (const issue of issues) {
    if (shouldSkipIssue(issue, config.labelsToSkip)) continue;
    documents.push(
      issueToDocument({
        issue,
        baseUrl: config.jiraBaseUrl,
        isCloud: config.isCloud,
        commentEmailBlacklist: config.commentEmailBlacklist,
      }),
    );
  }
  return documents;
}

function buildBatch(params: {
  documents: ConnectorDocument[];
  // biome-ignore lint/suspicious/noExplicitAny: SDK issue types vary between v2/v3
  issues: any[];
  failures: ConnectorItemFailure[];
  checkpoint: JiraCheckpoint;
  hasMore: boolean;
}): ConnectorSyncBatch {
  const { documents, issues, failures, checkpoint, hasMore } = params;
  const lastIssue = issues.length > 0 ? issues[issues.length - 1] : null;
  const rawUpdatedAt: string | undefined = lastIssue?.fields?.updated;

  return {
    documents,
    failures,
    checkpoint: buildCheckpoint({
      type: "jira",
      itemUpdatedAt: rawUpdatedAt,
      previousLastSyncedAt: checkpoint.lastSyncedAt,
      extra: {
        lastIssueKey: lastIssue?.key ?? checkpoint.lastIssueKey,
        lastRawUpdatedAt: rawUpdatedAt ?? checkpoint.lastRawUpdatedAt,
      },
    }),
    hasMore,
  };
}

/**
 * Extract HTTP status, URL, and response body from jira.js errors.
 * The library wraps Axios errors, so we dig into the cause/response chain.
 */
function extractJiraErrorDetails(
  error: unknown,
  depth = 0,
): Record<string, unknown> {
  const details: Record<string, unknown> = {};

  if (depth > 5 || !(error instanceof Error)) {
    return details;
  }

  // jira.js wraps Axios errors — check for response properties
  // biome-ignore lint/suspicious/noExplicitAny: error shape varies
  const err = error as any;

  // Axios-style: error.response.status / error.response.data
  if (err.response) {
    details.status = err.response.status;
    details.statusText = err.response.statusText;
    const cfg = err.response.config ?? err.config;
    if (cfg?.url) {
      details.url = cfg.baseURL
        ? `${cfg.baseURL.replace(/\/+$/, "")}${cfg.url}`
        : cfg.url;
    }
    if (err.response.data) {
      try {
        details.responseBody =
          typeof err.response.data === "string"
            ? err.response.data.slice(0, 1000)
            : JSON.stringify(err.response.data).slice(0, 1000);
      } catch {
        details.responseBody = "[unserializable]";
      }
    }
  }

  // Fallback: request config without response (e.g. network error)
  if (!details.url && err.config?.url) {
    const cfg = err.config;
    details.url = cfg.baseURL
      ? `${cfg.baseURL.replace(/\/+$/, "")}${cfg.url}`
      : cfg.url;
  }

  // Some errors store status directly
  if (!details.status && err.status) {
    details.status = err.status;
  }

  // Check cause chain (with depth limit to prevent stack overflow from circular refs)
  if (err.cause && !details.status) {
    Object.assign(details, extractJiraErrorDetails(err.cause, depth + 1));
  }

  return details;
}

function parseJiraConfig(config: Record<string, unknown>): JiraConfig | null {
  const result = JiraConfigSchema.safeParse({ type: "jira", ...config });
  return result.success ? result.data : null;
}

function buildJql(
  config: JiraConfig,
  checkpoint: JiraCheckpoint,
  startTime?: Date,
  // Merged into the WHERE clauses BEFORE the ORDER BY suffix — callers must
  // never string-append `AND ...` to the returned JQL (the suffix makes that
  // a syntax error Jira rejects with a 400).
  extraClauses?: string[],
): string {
  const clauses: string[] = [];

  const projectKeyList = getProjectKeyList(config);
  if (projectKeyList.length === 1) {
    clauses.push(`project = "${projectKeyList[0]}"`);
  } else if (projectKeyList.length > 1) {
    clauses.push(
      `project IN (${projectKeyList.map((key) => `"${key}"`).join(", ")})`,
    );
  }

  if (config.jqlQuery) {
    clauses.push(`(${config.jqlQuery})`);
  }

  // Prefer the raw Jira timestamp (includes timezone offset) so the JQL date
  // is formatted in the Jira user's local timezone.  Fall back to the UTC
  // `lastSyncedAt` for backward compatibility with old checkpoints — subtract
  // a safety buffer to account for unknown timezone offsets (max ±14 hours).
  const rawTimestamp = checkpoint.lastRawUpdatedAt;
  if (rawTimestamp) {
    const jiraDate = formatJiraLocalDate(rawTimestamp);
    clauses.push(`updated >= "${jiraDate}"`);
  } else {
    const syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
    if (syncFrom) {
      const jiraDate = formatJiraDateWithSafetyBuffer(syncFrom);
      clauses.push(`updated >= "${jiraDate}"`);
    }
  }

  if (extraClauses) {
    clauses.push(...extraClauses);
  }

  // Enhanced search requires at least one restriction (bounded query)
  if (clauses.length === 0) {
    clauses.push("project IS NOT EMPTY");
  }

  // Dedupe exact repeats (e.g. a single-project config plus a per-project
  // extra clause for that same project).
  const uniqueClauses = [...new Set(clauses)];
  const jql = uniqueClauses.join(" AND ");
  if (!uniqueClauses.some((c) => c.includes("ORDER BY"))) {
    return `${jql} ORDER BY updated ASC`;
  }
  return jql;
}

function getProjectKeyList(config: JiraConfig): string[] {
  const keys = config.projectKey?.split(",") ?? [];
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}

// biome-ignore lint/suspicious/noExplicitAny: SDK issue types vary between v2/v3
function shouldSkipIssue(issue: any, labelsToSkip?: string[]): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  const issueLabels: string[] = issue.fields?.labels ?? [];
  return issueLabels.some((label: string) => labelsToSkip.includes(label));
}

/**
 * Format an ISO 8601 timestamp with timezone offset (e.g. "2026-03-09T11:05:52.774-0400")
 * by extracting the LOCAL date/time components.  Jira JQL interprets date literals in the
 * authenticating user's timezone, so we must use the local time, not UTC.
 * @public — exported for testability
 */
export function formatJiraLocalDate(rawTimestamp: string): string {
  const match = rawTimestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}`;
  }
  // Fallback: treat as UTC (old behavior for plain ISO strings like "2026-03-09T15:05:52.774Z")
  return formatJiraDate(rawTimestamp);
}

/**
 * Format a UTC ISO timestamp for JQL, subtracting 14 hours to account for
 * the worst-case timezone offset (UTC+14). This ensures no issues are missed
 * when the user's Jira timezone is unknown. Already-synced issues will be
 * skipped by the content hash check.
 * Used only for old checkpoints that lack `lastRawUpdatedAt`.
 */
function formatJiraDateWithSafetyBuffer(isoDate: string): string {
  const d = new Date(isoDate);
  d.setUTCHours(d.getUTCHours() - 14);
  return formatJiraDate(d.toISOString());
}

function formatJiraDate(isoDate: string): string {
  const d = new Date(isoDate);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

function toDateOnly(iso: string | undefined): string | undefined {
  return iso?.slice(0, 10);
}

function issueToDocument(params: {
  // biome-ignore lint/suspicious/noExplicitAny: SDK issue types vary between v2/v3
  issue: any;
  baseUrl: string;
  isCloud: boolean;
  commentEmailBlacklist?: string[];
}): ConnectorDocument {
  const { issue, baseUrl, isCloud, commentEmailBlacklist } = params;
  const fields = issue.fields ?? {};

  const descriptionText = isCloud
    ? extractTextFromAdf(fields.description)
    : String(fields.description ?? "");

  const rawComments: unknown[] = fields.comment?.comments ?? [];
  const comments = rawComments
    .filter((c: unknown) => {
      const comment = c as Record<string, unknown>;
      const author = comment.author as Record<string, unknown> | undefined;
      return !commentEmailBlacklist?.includes(
        String(author?.emailAddress ?? ""),
      );
    })
    .map((c: unknown) => formatComment(c, isCloud))
    .filter(Boolean);

  const contentParts = [`# ${fields.summary}`, "", descriptionText];

  if (comments.length > 0) {
    contentParts.push("", "## Comments", "", ...comments);
  }

  return {
    id: issue.key,
    title: fields.summary ?? issue.key,
    content: contentParts.join("\n"),
    sourceUrl: `${baseUrl.replace(/\/+$/, "")}/browse/${issue.key}`,
    metadata: {
      issueKey: issue.key,
      issueType: fields.issuetype?.name,
      status: fields.status?.name,
      priority: fields.priority?.name,
      reporter: fields.reporter?.displayName,
      reporterEmail: fields.reporter?.emailAddress,
      assignee: fields.assignee?.displayName,
      assigneeEmail: fields.assignee?.emailAddress,
      labels: fields.labels,
      project: fields.project?.key,
      projectName: fields.project?.name,
      resolution: fields.resolution?.name,
      resolutionDate: toDateOnly(fields.resolutiondate),
      parent: fields.parent?.key,
      created: toDateOnly(fields.created),
      updated: toDateOnly(fields.updated),
      dueDate: toDateOnly(fields.duedate),
    },
    updatedAt: fields.updated ? new Date(fields.updated) : undefined,
  };
}

function formatComment(comment: unknown, isCloud: boolean): string {
  const c = comment as Record<string, unknown>;
  const author = c.author as Record<string, unknown> | undefined;
  const authorName = String(author?.displayName ?? "Unknown");
  const date = c.created
    ? new Date(String(c.created)).toISOString().slice(0, 10)
    : "";
  const body = isCloud ? extractTextFromAdf(c.body) : String(c.body ?? "");

  if (!body.trim()) return "";
  return `**${authorName}** (${date}): ${body}`;
}

/**
 * Extract plain text from Atlassian Document Format (ADF).
 * ADF is a nested JSON structure used by Jira Cloud v3.
 * @public — exported for testability
 */
export function extractTextFromAdf(adf: unknown): string {
  if (adf == null) return "";
  if (typeof adf === "string") return adf;
  if (typeof adf !== "object") return String(adf);

  const node = adf as Record<string, unknown>;

  if (node.type === "text" && typeof node.text === "string") {
    return node.text;
  }

  if (Array.isArray(node.content)) {
    const parts: string[] = [];
    for (const child of node.content) {
      const text = extractTextFromAdf(child);
      if (text) parts.push(text);
    }

    if (
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "bulletList" ||
      node.type === "orderedList" ||
      node.type === "listItem" ||
      node.type === "blockquote" ||
      node.type === "codeBlock" ||
      node.type === "table" ||
      node.type === "tableRow" ||
      node.type === "tableCell" ||
      node.type === "tableHeader"
    ) {
      return `${parts.join("")}\n`;
    }

    return parts.join("");
  }

  return "";
}
