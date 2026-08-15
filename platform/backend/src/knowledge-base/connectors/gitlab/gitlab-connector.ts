import { Gitlab } from "@gitbeaker/rest";
import { LRUCacheManager } from "@/cache-manager";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  GitlabCheckpoint,
  GitlabConfig,
  GroupMembershipYield,
  GroupMemberYield,
  PermissionSnapshotYield,
  PermissionSyncParams,
} from "@/types";
import { GitlabConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";
import { ConnectorIdentityCache } from "../identity-cache";

const BATCH_SIZE = 50;
/** Cap for the per-pass user → profile cache: sized so a normal instance never evicts. */
const USER_PROFILE_CACHE_MAX_SIZE = 10_000;
const READBACK_PAGE_SIZE = 200;
/**
 * Minimum access level whose members land in a project's audience. Reporter
 * (20) is the lowest role that can read repository code, merge requests, and
 * confidential issues on a private project — everything this connector
 * ingests. Guests (10) can read plain issues but not code, and ingested issue
 * documents carry no confidential flag, so admitting Guests would over-grant
 * them code and confidential-issue content. Excluding them is the fail-closed
 * direction: a Guest loses plain-issue retrieval, never the other way around.
 */
const REPORTER_ACCESS_LEVEL = 20;

export class GitlabConnector extends BaseConnector {
  type = "gitlab" as const;
  supportsPermissionSync = true;

  /**
   * Per-pass cache of GitLab username → profile (email null when hidden).
   * Size-bounded LRU (no TTL — the instance is per-pass): a member inherited
   * from a big ancestor group appears in every one of its projects' rosters,
   * and must cost one profile lookup, not one per project.
   */
  private userProfileCache = new LRUCacheManager<GitlabProfile>({
    maxSize: USER_PROFILE_CACHE_MAX_SIZE,
    defaultTtl: 0,
  });
  /**
   * Cross-pass persistence behind `userProfileCache`: username → profile
   * results (including hidden-email negatives) survive the pass so the next
   * run does not re-probe every member. Armed per permission pass.
   */
  private persistentProfileCache: ConnectorIdentityCache<GitlabProfile> | null =
    null;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseGitlabConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error: "Invalid GitLab configuration: gitlabUrl (string) is required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.gitlabUrl)) {
      return {
        valid: false,
        error: "gitlabUrl must be a valid HTTP(S) URL",
      };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseGitlabConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid GitLab configuration" };
    }

    this.log.debug({ baseUrl: parsed.gitlabUrl }, "Testing connection");

    try {
      const client = createGitlabClient(parsed, params.credentials);
      await client.Users.showCurrentUser();
      this.log.debug("Connection test successful");
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error({ error: message }, "Connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseGitlabConfig(params.config);
    if (!parsed) return null;

    // Markdown file count cannot be estimated without fetching the full repo tree,
    // so skip estimation entirely when markdown syncing is enabled.
    if (parsed.includeMarkdownFiles) return null;

    this.log.debug(
      { projectIds: parsed.projectIds, groupId: parsed.groupId },
      "Estimating total items",
    );

    try {
      const client = createGitlabClient(parsed, params.credentials);
      const projects = await getProjects(client, parsed);
      let total = 0;

      for (const project of projects) {
        if (parsed.includeIssues !== false) {
          const result = await client.Issues.all({
            projectId: project.id,
            perPage: 1,
            page: 1,
            showExpanded: true,
          });
          // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker expanded response includes paginationInfo
          const expanded = result as any;
          total += expanded?.paginationInfo?.total ?? 0;
        }

        if (parsed.includeMergeRequests !== false) {
          const result = await client.MergeRequests.all({
            projectId: project.id,
            perPage: 1,
            page: 1,
            showExpanded: true,
          });
          // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker expanded response includes paginationInfo
          const expanded = result as any;
          total += expanded?.paginationInfo?.total ?? 0;
        }
      }

      return total > 0 ? total : null;
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
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
    const parsed = parseGitlabConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid GitLab configuration");
    }

    const checkpoint = (params.checkpoint as GitlabCheckpoint | null) ?? {
      type: "gitlab" as const,
    };
    const client = createGitlabClient(parsed, params.credentials);
    const projects = await getProjects(client, parsed);

    this.log.debug(
      {
        baseUrl: parsed.gitlabUrl,
        projectCount: projects.length,
        includeIssues: parsed.includeIssues,
        includeMergeRequests: parsed.includeMergeRequests,
        checkpoint,
      },
      "Starting sync",
    );

    for (let projIdx = 0; projIdx < projects.length; projIdx++) {
      const project = projects[projIdx];
      const isLastProject = projIdx === projects.length - 1;
      const hasMarkdown = parsed.includeMarkdownFiles === true;

      if (parsed.includeIssues !== false) {
        yield* this.syncProjectIssues({
          client,
          config: parsed,
          project,
          checkpoint,
          isLastGroup:
            isLastProject &&
            parsed.includeMergeRequests === false &&
            !hasMarkdown,
        });
      }

      if (parsed.includeMergeRequests !== false) {
        yield* this.syncProjectMergeRequests({
          client,
          config: parsed,
          project,
          checkpoint,
          isLastGroup: isLastProject && !hasMarkdown,
        });
      }

      if (hasMarkdown) {
        yield* this.syncProjectMarkdownFiles({
          client,
          project,
          checkpoint,
          isLastGroup: isLastProject,
        });
      }
    }
  }

  // ===== Permission sync hooks =====

  /**
   * Project-scoped snapshot, one top-level container per project keyed
   * `project:<path_with_namespace>` (byte-matching content-sync's
   * `metadata.project`). A container's audience is a single group reference —
   * the project's own roster group (see `gitlabProjectGroupId`) — so audiences
   * stay O(1) regardless of member count and every member enumeration happens
   * exactly once, in `syncGroups`. Public and internal projects are org-wide:
   * both visibilities let any signed-in instance user read the project, which
   * is the granularity `org:*` models. Already-ingested documents are assigned
   * via read-back — upstream calls are O(projects), never O(docs). The
   * read-back mirrors our own corpus, so the per-container fail-close diff is
   * naturally empty (content-sync owns document deletions); a project that
   * VANISHES upstream is caught by the pass's stale container sweep.
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseGitlabConfig(params.config);
    if (!config) {
      throw new Error("Invalid GitLab configuration for permission sync");
    }
    const client = createGitlabClient(config, params.credentials);
    const host = gitlabInstanceId(config);
    const projects = sortedUniqueProjects(await getProjects(client, config));

    const scope = params.scope ? new Set(params.scope.containerKeys) : null;
    for (const project of projects) {
      const containerKey = `project:${project.pathWithNamespace}`;
      if (scope && !scope.has(containerKey)) continue;
      // Resume: containers strictly before the cursor are already done. The
      // cursor container is re-processed (idempotent — same audience).
      if (params.cursor && containerKey < params.cursor) continue;

      yield {
        kind: "container",
        containerKey,
        permissions: {
          isPublic:
            project.visibility === "public" ||
            project.visibility === "internal",
          users: [],
          groups: [gitlabProjectGroupId(host, project.pathWithNamespace)],
        },
        audienceResolutionFailed: false,
        cursor: containerKey,
      };

      let afterId: string | null = null;
      for (;;) {
        const { documents, nextAfterId } = await params.readIngestedDocuments({
          metadataFilter: { project: project.pathWithNamespace },
          afterId,
          limit: READBACK_PAGE_SIZE,
        });
        for (const doc of documents) {
          yield {
            kind: "document",
            sourceId: doc.sourceId,
            containerKey,
            cursor: containerKey,
          };
        }
        if (documents.length < READBACK_PAGE_SIZE) break;
        afterId = nextAfterId;
      }
    }
  }

  /**
   * Local-adoption scoping for the pass: a stored document is covered by its
   * project's enumeration (content-sync writes `metadata.project` =
   * `<path_with_namespace>`, matching the container key). Scoping only — the
   * project enumeration resolves the authoritative audience, so this can
   * never over-grant.
   */
  scopeKeyForDocument(metadata: Record<string, unknown>): string | null {
    const project = metadata.project;
    return typeof project === "string" && project.length > 0
      ? `project:${project}`
      : null;
  }

  /**
   * One roster group per project: id `<instance>//<path_with_namespace>`,
   * members from `GET /projects/:id/members/all` (direct + inherited from
   * ancestor groups + invited groups — GitLab flattens them all with the
   * member's EFFECTIVE access level, so filtering to Reporter+ is exact where
   * granting whole upstream GitLab groups could not be: a Guest-level member
   * of an ancestor group must not ride its grant into code content).
   *
   * The instance prefix keeps the id globally distinctive across connectors of
   * the same type: group tokens are namespaced by connector TYPE only (see
   * acl-tokens.ts), and unlike github.com org names, GitLab project paths are
   * only unique per instance — a bare `acme/docs` id would collide between two
   * self-hosted instances and cross-grant their corpora.
   *
   * A project whose member list cannot be read yields
   * `membershipResolutionFailed` — the pass replaces the roster with an empty
   * fail-closed membership (project goes dark) rather than keeping a
   * possibly-revoked grant alive.
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseGitlabConfig(params.config);
    if (!config) {
      throw new Error("Invalid GitLab configuration for group sync");
    }
    const client = createGitlabClient(config, params.credentials);
    const host = gitlabInstanceId(config);
    this.initPersistentProfileCache(config, params.credentials, {
      refresh: params.refreshIdentities,
    });
    const projects = sortedUniqueProjects(await getProjects(client, config));

    const scope = params.scope?.groupIds
      ? new Set(params.scope.groupIds)
      : null;
    for (const project of projects) {
      const groupId = gitlabProjectGroupId(host, project.pathWithNamespace);
      if (scope && !scope.has(groupId)) continue;
      const name = `${project.pathWithNamespace} members`;

      // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
      let rawMembers: any[];
      try {
        await this.rateLimit();
        rawMembers = (await client.ProjectMembers.all(project.id, {
          includeInherited: true,
          perPage: 100,
          // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
        })) as any[];
      } catch (error) {
        this.log.error(
          {
            project: project.pathWithNamespace,
            error: extractErrorMessage(error),
          },
          "Could not read the project's member list; its roster is fail-closed for this pass",
        );
        yield {
          groupId,
          name,
          members: [],
          membershipResolutionFailed: true,
          cursor: groupId,
        };
        continue;
      }

      const members = new Map<string, GroupMemberYield>();
      for (const member of rawMembers) {
        if ((member.access_level ?? 0) < REPORTER_ACCESS_LEVEL) continue;
        // A blocked (or pending) account cannot sign in upstream; its email
        // must not keep resolving to grants here.
        if (member.state && member.state !== "active") continue;
        const username = String(member.username);
        // Every member is recorded; GitLab only exposes an email the user made
        // public (or, on some tiers, to group owners — carried on the member
        // row itself), so `email` is often null: fail-closed, but visible to
        // admins as unresolvable and rescuable with a member mapping instead
        // of silently dropped.
        const profile = await this.resolveUserProfile(client, {
          username,
          userId: Number(member.id),
          known: { email: member.email, name: member.name },
        });
        members.set(username, {
          accountId: username,
          displayName: profile.name ?? null,
          email: profile.email ?? null,
          accountType: profile.bot ? "bot" : null,
        });
      }

      yield {
        groupId,
        name,
        members: [...members.values()],
        cursor: groupId,
      };
    }
  }

  // ===== Private methods =====

  /**
   * Resolve a member to their profile. `known` is the email/name the member
   * listing already carried (GitLab includes `email` for group owners on some
   * tiers and for instance admins) — when present it costs no request. The
   * fallback `GET /users/:id` exposes only `public_email` to a normal token,
   * so `email` stays null for most members (fail-closed, documented
   * limitation).
   */
  private async resolveUserProfile(
    client: InstanceType<typeof Gitlab>,
    params: {
      username: string;
      userId: number;
      known?: { email?: string | null; name?: string | null };
    },
  ): Promise<GitlabProfile> {
    if (params.known?.email) {
      const profile: GitlabProfile = {
        email: String(params.known.email),
        name: params.known.name ? String(params.known.name) : null,
        bot: isBotUsername(params.username),
      };
      this.userProfileCache.set(params.username, profile);
      await this.persistentProfileCache?.set(params.username, profile);
      return profile;
    }

    const cached = this.userProfileCache.get(params.username);
    if (cached !== undefined) return cached;
    const persisted = await this.persistentProfileCache?.get(params.username);
    if (persisted !== undefined) {
      this.userProfileCache.set(params.username, persisted);
      return persisted;
    }

    let profile: GitlabProfile = {
      email: null,
      name: params.known?.name ? String(params.known.name) : null,
      bot: isBotUsername(params.username),
    };
    try {
      await this.rateLimit();
      // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
      const user: any = await client.Users.show(params.userId);
      profile = {
        email: user.email ? String(user.email) : userPublicEmail(user),
        name: user.name ? String(user.name) : profile.name,
        bot: user.bot === true || isBotUsername(params.username),
      };
    } catch (error) {
      this.log.debug(
        { username: params.username, error: extractErrorMessage(error) },
        "Could not resolve GitLab user profile",
      );
    }
    this.userProfileCache.set(params.username, profile);
    await this.persistentProfileCache?.set(params.username, profile);
    return profile;
  }

  /** Arm the cross-pass profile cache for one permission pass. */
  private initPersistentProfileCache(
    config: GitlabConfig,
    credentials: ConnectorCredentials,
    opts: { refresh?: boolean },
  ): void {
    this.persistentProfileCache = new ConnectorIdentityCache({
      namespace: "gitlab-profile",
      host: config.gitlabUrl,
      credentials,
      refresh: opts.refresh,
    });
  }

  private async *syncProjectIssues(params: {
    client: InstanceType<typeof Gitlab>;
    config: GitlabConfig;
    project: GitlabProject;
    checkpoint: GitlabCheckpoint;
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { client, config, project, checkpoint, isLastGroup } = params;
    let page = 1;
    let pageHasMore = true;

    this.log.debug(
      { project: project.pathWithNamespace },
      "Syncing project issues",
    );

    while (pageHasMore) {
      await this.rateLimit();

      try {
        this.log.debug(
          { project: project.pathWithNamespace, page },
          "Fetching issues batch",
        );

        // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
        const issues: any[] = await client.Issues.all({
          projectId: project.id,
          perPage: BATCH_SIZE,
          page,
          sort: "asc",
          orderBy: "updated_at",
          ...(checkpoint.lastSyncedAt
            ? { updatedAfter: checkpoint.lastSyncedAt }
            : {}),
        });

        const filtered = issues.filter(
          (issue: { labels?: string[] }) =>
            !shouldSkipByLabels(issue.labels ?? [], config.labelsToSkip),
        );

        const documents: ConnectorDocument[] = [];
        for (const issue of filtered) {
          await this.rateLimit();
          const notes = await this.safeItemFetch({
            fetch: () => getIssueNotes(client, project.id, issue.iid),
            fallback: [],
            itemId: issue.iid,
            resource: "notes",
          });
          documents.push(issueToDocument(issue, notes, project));
        }

        pageHasMore = issues.length >= BATCH_SIZE;
        page++;

        this.log.debug(
          {
            project: project.pathWithNamespace,
            issueCount: issues.length,
            documentCount: documents.length,
            hasMore: pageHasMore || !isLastGroup,
          },
          "Issues batch fetched",
        );

        const lastIssue =
          filtered.length > 0 ? filtered[filtered.length - 1] : null;
        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "gitlab",
            itemUpdatedAt: lastIssue?.updated_at,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore: pageHasMore || !isLastGroup,
        };
      } catch (error) {
        this.log.error(
          {
            project: project.pathWithNamespace,
            page,
            error: extractErrorMessage(error),
          },
          "Issues batch fetch failed",
        );
        throw error;
      }
    }
  }

  private async *syncProjectMergeRequests(params: {
    client: InstanceType<typeof Gitlab>;
    config: GitlabConfig;
    project: GitlabProject;
    checkpoint: GitlabCheckpoint;
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { client, config, project, checkpoint, isLastGroup } = params;
    let page = 1;
    let pageHasMore = true;

    this.log.debug(
      { project: project.pathWithNamespace },
      "Syncing project merge requests",
    );

    while (pageHasMore) {
      await this.rateLimit();

      try {
        this.log.debug(
          { project: project.pathWithNamespace, page },
          "Fetching merge requests batch",
        );

        // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
        const mergeRequests: any[] = await client.MergeRequests.all({
          projectId: project.id,
          perPage: BATCH_SIZE,
          page,
          sort: "asc",
          orderBy: "updated_at",
          ...(checkpoint.lastSyncedAt
            ? { updatedAfter: checkpoint.lastSyncedAt }
            : {}),
        });

        const filtered = mergeRequests.filter(
          (mr: { labels?: string[] }) =>
            !shouldSkipByLabels(mr.labels ?? [], config.labelsToSkip),
        );

        const documents: ConnectorDocument[] = [];
        for (const mr of filtered) {
          await this.rateLimit();
          const notes = await this.safeItemFetch({
            fetch: () => getMergeRequestNotes(client, project.id, mr.iid),
            fallback: [],
            itemId: mr.iid,
            resource: "notes",
          });
          documents.push(mergeRequestToDocument(mr, notes, project));
        }

        pageHasMore = mergeRequests.length >= BATCH_SIZE;
        page++;

        this.log.debug(
          {
            project: project.pathWithNamespace,
            mrCount: mergeRequests.length,
            documentCount: documents.length,
            hasMore: pageHasMore || !isLastGroup,
          },
          "Merge requests batch fetched",
        );

        const lastMr =
          filtered.length > 0 ? filtered[filtered.length - 1] : null;
        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "gitlab",
            itemUpdatedAt: lastMr?.updated_at,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore: pageHasMore || !isLastGroup,
        };
      } catch (error) {
        this.log.error(
          {
            project: project.pathWithNamespace,
            page,
            error: extractErrorMessage(error),
          },
          "Merge requests batch fetch failed",
        );
        throw error;
      }
    }
  }
  private async *syncProjectMarkdownFiles(params: {
    client: InstanceType<typeof Gitlab>;
    project: GitlabProject;
    checkpoint: GitlabCheckpoint;
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { client, project, checkpoint, isLastGroup } = params;

    this.log.info(
      { project: project.pathWithNamespace },
      "Starting markdown file sync",
    );

    this.log.debug(
      { project: project.pathWithNamespace, ref: "HEAD" },
      "Fetching repository tree",
    );

    // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
    let treeItems: any[];
    try {
      treeItems = (await client.Repositories.allRepositoryTrees(project.id, {
        recursive: true,
        // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
      })) as any[];
    } catch (err) {
      this.log.error(
        {
          project: project.pathWithNamespace,
          ref: "HEAD",
          error: extractErrorMessage(err),
        },
        "Failed to fetch repository tree, skipping markdown sync",
      );
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "gitlab",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    const markdownFiles = treeItems.filter(
      (item) => item.type === "blob" && isMarkdownFile(String(item.path ?? "")),
    );

    this.log.info(
      {
        project: project.pathWithNamespace,
        ref: "HEAD",
        totalTreeItems: treeItems.length,
        markdownFileCount: markdownFiles.length,
      },
      "Found markdown files in project",
    );

    if (markdownFiles.length === 0) {
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "gitlab",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    for (let i = 0; i < markdownFiles.length; i += BATCH_SIZE) {
      const batch = markdownFiles.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(markdownFiles.length / BATCH_SIZE);
      const documents: ConnectorDocument[] = [];

      this.log.debug(
        {
          project: project.pathWithNamespace,
          ref: "HEAD",
          batch: batchNumber,
          totalBatches,
          batchSize: batch.length,
        },
        "Fetching markdown file contents",
      );

      for (const file of batch) {
        await this.rateLimit();
        const filePath = String(file.path);
        const content = await this.safeItemFetch({
          fetch: () => getFileContent(client, project.id, filePath),
          fallback: null,
          itemId: filePath,
          resource: "file_content",
          itemUnavailable: true,
        });

        if (content !== null) {
          documents.push(markdownFileToDocument(filePath, content, project));
        }
      }

      const failures = this.flushFailures();
      const hasMoreFiles = i + BATCH_SIZE < markdownFiles.length;

      this.log.info(
        {
          project: project.pathWithNamespace,
          ref: "HEAD",
          batch: batchNumber,
          totalBatches,
          documentsIndexed: documents.length,
          failureCount: failures.length,
          hasMore: hasMoreFiles || !isLastGroup,
        },
        "Markdown file batch completed",
      );

      yield {
        documents,
        failures,
        checkpoint: buildCheckpoint({
          type: "gitlab",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: hasMoreFiles || !isLastGroup,
      };
    }
  }
}

// ===== Module-level helpers =====

interface GitlabProject {
  id: number;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  /** "private" | "internal" | "public"; missing reads as private (fail-closed). */
  visibility?: string;
}

interface GitlabProfile {
  email: string | null;
  name: string | null;
  bot: boolean;
}

/**
 * The connector's upstream identity space: host (with port) plus any
 * relative-URL subpath the instance is served under, lowercased, no protocol,
 * no trailing slash — e.g. `gitlab.example.com:8443` or `example.com/gitlab`.
 * Two connectors pointing at the same instance MUST derive the same id (their
 * group tokens are meant to be shared); different instances must never.
 */
function gitlabInstanceId(config: GitlabConfig): string {
  const url = new URL(config.gitlabUrl);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.host}${path}`.toLowerCase();
}

/**
 * Roster-group id for one project: `<instance>//<path_with_namespace>`. The
 * double slash cannot occur inside either half (hostnames, instance subpaths,
 * and GitLab namespace paths are all single-slash-normalized), so the mapping
 * is unambiguous — `example.com/gitlab` + `a/b` never reads as `example.com`
 * + `gitlab/a/b`. Written on container audiences and stored by syncGroups
 * identically, so the group data-contract byte-matches.
 */
function gitlabProjectGroupId(
  instanceId: string,
  pathWithNamespace: string,
): string {
  return `${instanceId}//${pathWithNamespace}`;
}

/**
 * Stable codepoint order so the resume cursor (a container key) is monotonic
 * under plain string comparison, deduplicated by path so a project reachable
 * twice (e.g. a duplicated config id) yields one container and one roster.
 */
function sortedUniqueProjects(projects: GitlabProject[]): GitlabProject[] {
  const byPath = new Map<string, GitlabProject>();
  for (const project of projects) {
    byPath.set(project.pathWithNamespace, project);
  }
  return [...byPath.values()].sort((a, b) => {
    const left = a.pathWithNamespace;
    const right = b.pathWithNamespace;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * GitLab's own naming convention for the bot accounts backing project/group
 * access tokens. Best-effort classification for admin stats only — never used
 * for access decisions.
 */
function isBotUsername(username: string): boolean {
  return username.startsWith("project_bot") || username.startsWith("group_bot");
}

// biome-ignore lint/suspicious/noExplicitAny: GitLab API response types
function userPublicEmail(user: any): string | null {
  return user.public_email ? String(user.public_email) : null;
}

function createGitlabClient(
  config: GitlabConfig,
  credentials: ConnectorCredentials,
): InstanceType<typeof Gitlab> {
  return new Gitlab({
    host: config.gitlabUrl.replace(/\/+$/, ""),
    token: credentials.apiToken,
  });
}

function parseGitlabConfig(
  config: Record<string, unknown>,
): GitlabConfig | null {
  const result = GitlabConfigSchema.safeParse({ type: "gitlab", ...config });
  return result.success ? result.data : null;
}

async function getProjects(
  client: InstanceType<typeof Gitlab>,
  config: GitlabConfig,
): Promise<GitlabProject[]> {
  if (config.projectIds && config.projectIds.length > 0) {
    const projects: GitlabProject[] = [];
    for (const projectId of config.projectIds) {
      // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
      const project: any = await client.Projects.show(projectId);
      projects.push({
        id: project.id,
        name: project.name,
        pathWithNamespace: String(project.path_with_namespace),
        webUrl: String(project.web_url),
        visibility: project.visibility ? String(project.visibility) : undefined,
      });
    }
    return projects;
  }

  if (config.groupId) {
    const groupProjects = (await client.Groups.allProjects(config.groupId, {
      perPage: 100,
      // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
    })) as any[];
    return groupProjects.map((p) => ({
      id: p.id,
      name: p.name,
      pathWithNamespace: String(p.path_with_namespace),
      webUrl: String(p.web_url),
      visibility: p.visibility ? String(p.visibility) : undefined,
    }));
  }

  const allProjects = (await client.Projects.all({
    membership: true,
    perPage: 100,
    // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
  })) as any[];
  return allProjects.map((p) => ({
    id: p.id,
    name: p.name,
    pathWithNamespace: String(p.path_with_namespace),
    webUrl: String(p.web_url),
    visibility: p.visibility ? String(p.visibility) : undefined,
  }));
}

async function getIssueNotes(
  client: InstanceType<typeof Gitlab>,
  projectId: number,
  issueIid: number,
): Promise<Array<{ author: string; body: string; date: string }>> {
  const notes = (await client.IssueNotes.all(projectId, issueIid, {
    perPage: 100,
    // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
  })) as any[];
  return notes
    .filter((n) => !n.system)
    .map((n) => ({
      author: String(n.author?.name ?? n.author?.username ?? "unknown"),
      body: String(n.body ?? ""),
      date: n.created_at
        ? new Date(String(n.created_at)).toISOString().slice(0, 10)
        : "",
    }));
}

async function getMergeRequestNotes(
  client: InstanceType<typeof Gitlab>,
  projectId: number,
  mrIid: number,
): Promise<Array<{ author: string; body: string; date: string }>> {
  const notes = (await client.MergeRequestNotes.all(projectId, mrIid, {
    perPage: 100,
    // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
  })) as any[];
  return notes
    .filter((n) => !n.system)
    .map((n) => ({
      author: String(n.author?.name ?? n.author?.username ?? "unknown"),
      body: String(n.body ?? ""),
      date: n.created_at
        ? new Date(String(n.created_at)).toISOString().slice(0, 10)
        : "",
    }));
}

function shouldSkipByLabels(
  itemLabels: string[],
  labelsToSkip?: string[],
): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  return itemLabels.some((label) => labelsToSkip.includes(label));
}

function isMarkdownFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}

async function getFileContent(
  client: InstanceType<typeof Gitlab>,
  projectId: number,
  filePath: string,
): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
  const file: any = await client.RepositoryFiles.show(
    projectId,
    filePath,
    "HEAD",
  );
  if (!file.content) {
    throw new Error(`No content returned for ${filePath}`);
  }
  return Buffer.from(String(file.content), "base64").toString("utf-8");
}

function markdownFileToDocument(
  filePath: string,
  content: string,
  project: GitlabProject,
): ConnectorDocument {
  const fileName = filePath.split("/").pop() ?? filePath;
  return {
    id: `${project.pathWithNamespace}#file:${filePath}`,
    title: `${fileName} (${project.pathWithNamespace})`,
    content,
    sourceUrl: `${project.webUrl}/-/blob/HEAD/${filePath}`,
    metadata: {
      project: project.pathWithNamespace,
      filePath,
      kind: "markdown_file",
    },
  };
}

function issueToDocument(
  // biome-ignore lint/suspicious/noExplicitAny: GitLab API response types
  issue: any,
  notes: Array<{ author: string; body: string; date: string }>,
  project: GitlabProject,
): ConnectorDocument {
  const contentParts = [`# Issue: ${issue.title}`, "", issue.description ?? ""];

  const nonEmptyNotes = notes.filter((n) => n.body.trim());
  if (nonEmptyNotes.length > 0) {
    contentParts.push("", "## Comments", "");
    for (const n of nonEmptyNotes) {
      contentParts.push(`**${n.author}** (${n.date}): ${n.body}`);
    }
  }

  return {
    id: `${project.pathWithNamespace}#issue-${issue.iid}`,
    title: `${issue.title} (${project.pathWithNamespace}#${issue.iid})`,
    content: contentParts.join("\n"),
    sourceUrl: issue.web_url,
    metadata: {
      project: project.pathWithNamespace,
      iid: issue.iid,
      state: issue.state,
      kind: "issue",
      labels: issue.labels ?? [],
      author: issue.author?.username,
    },
    updatedAt: issue.updated_at ? new Date(issue.updated_at) : undefined,
  };
}

function mergeRequestToDocument(
  // biome-ignore lint/suspicious/noExplicitAny: GitLab API response types
  mr: any,
  notes: Array<{ author: string; body: string; date: string }>,
  project: GitlabProject,
): ConnectorDocument {
  const contentParts = [
    `# Merge Request: ${mr.title}`,
    "",
    mr.description ?? "",
  ];

  const nonEmptyNotes = notes.filter((n) => n.body.trim());
  if (nonEmptyNotes.length > 0) {
    contentParts.push("", "## Comments", "");
    for (const n of nonEmptyNotes) {
      contentParts.push(`**${n.author}** (${n.date}): ${n.body}`);
    }
  }

  return {
    id: `${project.pathWithNamespace}#mr-${mr.iid}`,
    title: `${mr.title} (${project.pathWithNamespace}!${mr.iid})`,
    content: contentParts.join("\n"),
    sourceUrl: mr.web_url,
    metadata: {
      project: project.pathWithNamespace,
      iid: mr.iid,
      state: mr.state,
      kind: "merge_request",
      labels: mr.labels ?? [],
      author: mr.author?.username,
    },
    updatedAt: mr.updated_at ? new Date(mr.updated_at) : undefined,
  };
}
