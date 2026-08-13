import {
  ApiClient,
  ProjectMembershipsApi,
  ProjectsApi,
  StoriesApi,
  TasksApi,
  TeamMembershipsApi,
  TeamsApi,
  UsersApi,
  WorkspaceMembershipsApi,
  WorkspacesApi,
} from "asana";
import * as cheerio from "cheerio";
import * as metrics from "@/observability/metrics";
import type {
  AsanaCheckpoint,
  AsanaConfig,
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  DocumentPermissions,
  GroupMembershipYield,
  GroupMemberYield,
  PermissionSnapshotYield,
  PermissionSyncParams,
  ResolveMappedEmail,
} from "@/types";
import { AsanaConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const BATCH_SIZE = 50;
const SUB_RESOURCE_PAGE_LIMIT = 100;
/**
 * Subtract 5 min from the incremental checkpoint when filtering tasks so we
 * never skip a task modified right around the checkpoint boundary (covers both
 * timing edge cases and minor clock drift between Asana servers and ours).
 * Re-indexed documents are deduplicated downstream by their stable `id`.
 */
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

// Retry tuning (mirrors `base-connector.ts` so Asana feels the same to users).
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 10000;
const DEFAULT_RETRY_AFTER_SEC = 30;

const TASK_OPT_FIELDS = [
  "gid",
  "name",
  "notes",
  "html_notes",
  "completed",
  "modified_at",
  "created_at",
  "permalink_url",
  "assignee.name",
  "projects.name",
  "tags.name",
].join(",");

const PROJECT_OPT_FIELDS_WITH_WORKSPACE = "gid,name,workspace.gid";
const STORY_OPT_FIELDS = "gid,type,text,html_text,created_by.name,created_at";

// ----- Permission-sync opt_fields (ids and flags only, never content) -----
const PERMISSION_TASK_OPT_FIELDS = "gid,projects.gid,followers.gid";
const PERMISSION_PROJECT_OPT_FIELDS =
  "gid,name,privacy_setting,team.gid,workspace.gid";
const PROJECT_MEMBERSHIP_OPT_FIELDS = "member.gid,member.resource_type";
const WORKSPACE_USER_OPT_FIELDS = "email,name";
const WORKSPACE_MEMBERSHIP_OPT_FIELDS = "user.gid,user.name,is_guest,is_active";
const TEAM_MEMBERSHIP_OPT_FIELDS = "user.gid,user.name,is_limited_access";

export class AsanaConnector extends BaseConnector {
  type = "asana" as const;
  supportsPermissionSync = true;

  // ----- Per-pass permission-sync state (armed by initPermissionPass) -----
  /** Project gid → resolved audience (null = lookup failed, fail-closed). */
  private permAudienceByProjectGid = new Map<
    string,
    AsanaProjectAudience | null
  >();
  /** Workspace user gid → email/name, one walk per pass. */
  private permWorkspaceUsers: Map<string, AsanaWorkspaceUserInfo> | null = null;
  private permWorkspaceUsersFailed = false;
  private permDroppedPrincipals = 0;
  private permResolveMappedEmail: ResolveMappedEmail | null = null;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseAsanaConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error: "Invalid Asana configuration: workspaceGid (string) is required",
      };
    }
    return { valid: true };
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    // Asana's project task listing endpoint (`GET /projects/{gid}/tasks`) does
    // not return a total count, and `searchTasksForWorkspace` is premium-only
    // and eventually consistent. A cheap, reliable total is not available, so
    // we explicitly return null rather than doing a full-scan count pre-pass.
    void params.config;
    void params.credentials;
    void params.checkpoint;
    return null;
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseAsanaConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Asana configuration" };
    }

    this.log.debug({ workspaceGid: parsed.workspaceGid }, "Testing connection");

    try {
      const client = createAsanaClient(params.credentials);
      const usersApi = new UsersApi(client);
      await this.callWithRetry(() => usersApi.getUser("me", {}));
      this.log.debug("Connection test successful");
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error({ error: message }, "Connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseAsanaConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Asana configuration");
    }

    const checkpoint = (params.checkpoint as AsanaCheckpoint | null) ?? {
      type: "asana" as const,
    };
    const client = createAsanaClient(params.credentials);
    const projects = await this.getProjects(client, parsed);

    this.log.info(
      {
        workspaceGid: parsed.workspaceGid,
        projectCount: projects.length,
        checkpoint,
      },
      "Starting Asana sync",
    );

    // Monotonic high-water mark tracked across all projects/pages. A late
    // project returning an older `modified_at` must not regress the checkpoint.
    const progress: SyncProgress = {
      maxLastModified: checkpoint.lastSyncedAt,
    };

    // Tasks can be multi-homed in several projects (Asana's `projects` on a
    // task is an array). Without tracking, each project pass would re-emit
    // and re-fetch stories for the same task. De-dupe by task gid across the
    // whole sync so each task is processed once regardless of how many of
    // the selected projects it belongs to.
    const seenTaskGids = new Set<string>();

    for (let projIdx = 0; projIdx < projects.length; projIdx++) {
      const project = projects[projIdx];
      const isLastProject = projIdx === projects.length - 1;

      yield* this.syncProjectTasks({
        client,
        config: parsed,
        project,
        checkpoint,
        progress,
        seenTaskGids,
        isLastProject,
      });
    }
  }

  // ===== Permission sync =====
  //
  // Projection of Asana's sharing model onto the container-ACL system:
  //
  // - CONTAINER = an Asana project (`project:<gid>`), the audience-sharing
  //   unit. `public_to_workspace` projects grant the synthetic
  //   workspace-members group; every project additionally grants its explicit
  //   memberships — users by email, teams as `team:<gid>` groups. All Asana
  //   access levels (admin/editor/commenter/viewer) can read, so there is no
  //   level filtering. The deprecated `private_to_team` privacy value still
  //   grants the project's own team.
  // - MULTI-HOMED tasks (several home projects) are readable by anyone who
  //   can see ANY home project. They are assigned once, under their
  //   lowest-keyed scoped project, to a nested union container
  //   `project:<gid>/multi:<others>` whose audience unions every home
  //   project's audience (out-of-scope home projects contribute audience but
  //   never become top-level containers).
  // - Task COLLABORATORS (followers) can read a task regardless of project
  //   membership → per-document `exceptionUsers`.
  // - Asana gids are globally unique, so `team:<gid>` and
  //   `workspace-members:<workspaceGid>` ids cannot collide across two Asana
  //   connectors of different workspaces (group tokens are namespaced by
  //   connector TYPE only).
  // - Tasks the walk no longer sees (deleted, or removed from every synced
  //   project and therefore private to collaborators) are fail-closed by the
  //   pass's sweeps.
  // - No change probe: every pass is a full reconcile (GitHub precedent). The
  //   walk re-enumerates task ids/flags per project, never task content.

  /**
   * Snapshot generator (see the model comment above). Ordering contract:
   * top-level container keys ascend in plain string order, a container yield
   * precedes its documents, and `cursor` is always the current top-level key.
   */
  async *syncPermissionSnapshot(
    params: PermissionSyncParams,
  ): AsyncGenerator<PermissionSnapshotYield> {
    const config = parseAsanaConfig(params.config);
    if (!config) {
      throw new Error("Invalid Asana configuration for permission sync");
    }
    this.initPermissionPass(params);
    const apis = createPermissionApis(params.credentials);

    const projects = await this.getPermissionProjects(apis, config);
    const scope = params.scope ? new Set(params.scope.containerKeys) : null;
    // Multi-homed dedup across the whole pass: each task is assigned exactly
    // once, under its lowest-keyed scoped project — the same walk order and
    // dedup rule as the content sync.
    const seenTaskGids = new Set<string>();

    for (const project of projects) {
      const containerKey = projectContainerKey(project.gid);
      if (scope && !scope.has(containerKey)) continue;
      if (params.cursor && containerKey < params.cursor) continue;
      yield* this.syncProjectPermissionSnapshot({
        apis,
        config,
        project,
        seenTaskGids,
      });
    }
    this.reportDroppedPermissionPrincipals();
  }

  /**
   * Group rosters: the synthetic workspace-members group (audience of
   * `public_to_workspace` projects — guests and deactivated users excluded,
   * view-only members included) and every team visible to the credential.
   * Limited-access team members are excluded: Asana grants them only the
   * projects they are explicitly added to, which the project-membership path
   * already covers. Organization guests who are real team members remain
   * included. A team attached to a project but invisible to the credential is
   * never yielded, so its grant stays fail-closed.
   *
   * Failure semantics: a failed roster walk THROWS — the pass isolates the
   * group phase and the previous membership snapshot stays in force (a
   * truncated roster would silently revoke its tail; a null-email roster
   * would overwrite resolved emails fail-closed). Only a 403/404 on a single
   * team's roster yields that team as an observed fail-closed empty group.
   */
  async *syncGroups(
    params: PermissionSyncParams,
  ): AsyncGenerator<GroupMembershipYield> {
    const config = parseAsanaConfig(params.config);
    if (!config) {
      throw new Error("Invalid Asana configuration for group sync");
    }
    this.initPermissionPass(params);
    const apis = createPermissionApis(params.credentials);

    const users = await this.getWorkspaceUsers(apis, config, {
      required: true,
    });

    const workspaceName = await this.fetchWorkspaceName(apis, config);
    const memberships = await this.paginateAll<AsanaWorkspaceMembershipRecord>(
      (opts) =>
        apis.workspaceMemberships.getWorkspaceMembershipsForWorkspace(
          config.workspaceGid,
          { ...opts, opt_fields: WORKSPACE_MEMBERSHIP_OPT_FIELDS },
        ),
    );
    const workspaceMembers: GroupMemberYield[] = [];
    for (const membership of memberships) {
      const userGid = membership.user?.gid ? String(membership.user.gid) : null;
      if (!userGid) continue;
      // Guests only ever see what they are explicitly added to — they are
      // granted through project memberships, never the workspace audience.
      if (membership.is_guest === true) continue;
      if (membership.is_active === false) continue;
      workspaceMembers.push({
        accountId: userGid,
        displayName: membership.user?.name ?? users.get(userGid)?.name ?? null,
        email: users.get(userGid)?.email ?? null,
        accountType: "user",
      });
    }
    yield {
      groupId: workspaceMembersGroupId(config.workspaceGid),
      name: `${workspaceName} workspace members`,
      members: workspaceMembers,
    };

    const teams = await this.paginateAll<AsanaTeamRecord>((opts) =>
      apis.teams.getTeamsForWorkspace(config.workspaceGid, {
        ...opts,
        opt_fields: "name",
      }),
    );
    for (const team of [...teams].sort((a, b) =>
      compareStrings(a.gid, b.gid),
    )) {
      let roster: AsanaTeamMembershipRecord[];
      try {
        roster = await this.paginateAll<AsanaTeamMembershipRecord>((opts) =>
          apis.teamMemberships.getTeamMembershipsForTeam(team.gid, {
            ...opts,
            opt_fields: TEAM_MEMBERSHIP_OPT_FIELDS,
          }),
        );
      } catch (error) {
        if (isPermissionDeniedError(error)) {
          this.log.warn(
            { teamGid: team.gid, error: extractErrorMessage(error) },
            "Asana team roster unreadable; recording an observed fail-closed empty roster",
          );
          yield {
            groupId: teamGroupId(team.gid),
            name: team.name ?? null,
            members: [],
            membershipResolutionFailed: true,
          };
          continue;
        }
        throw error;
      }
      const members: GroupMemberYield[] = [];
      for (const membership of roster) {
        const userGid = membership.user?.gid
          ? String(membership.user.gid)
          : null;
        if (!userGid) continue;
        if (membership.is_limited_access === true) continue;
        members.push({
          accountId: userGid,
          displayName:
            membership.user?.name ?? users.get(userGid)?.name ?? null,
          email: users.get(userGid)?.email ?? null,
          accountType: "user",
        });
      }
      yield {
        groupId: teamGroupId(team.gid),
        name: team.name ?? null,
        members,
      };
    }
  }

  // ===== Private methods =====

  private async *syncProjectTasks(params: {
    client: ApiClient;
    config: AsanaConfig;
    project: AsanaProject;
    checkpoint: AsanaCheckpoint;
    progress: SyncProgress;
    seenTaskGids: Set<string>;
    isLastProject: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      client,
      config,
      project,
      checkpoint,
      progress,
      seenTaskGids,
      isLastProject,
    } = params;
    const tasksApi = new TasksApi(client);
    const storiesApi = new StoriesApi(client);

    this.log.debug(
      { project: project.name, gid: project.gid },
      "Syncing project tasks",
    );

    let offset: string | undefined;
    let pageHasMore = true;

    // Client-side `modified_at` filter with a small safety buffer for clock
    // skew / timing edge cases. Applied only when a previous checkpoint exists.
    const bufferedSince = checkpoint.lastSyncedAt
      ? new Date(
          new Date(checkpoint.lastSyncedAt).getTime() -
            INCREMENTAL_SAFETY_BUFFER_MS,
        )
      : null;

    while (pageHasMore) {
      await this.rateLimit();

      try {
        this.log.debug(
          { project: project.name, offset },
          "Fetching tasks batch",
        );

        const result = await this.callWithRetry(() =>
          tasksApi.getTasksForProject(project.gid, {
            limit: BATCH_SIZE,
            ...(offset ? { offset } : {}),
            opt_fields: TASK_OPT_FIELDS,
          }),
        );

        const tasks = extractCollectionData<AsanaTask>(result);
        const nextOffset = extractNextOffset(result);

        // Advance the monotonic high-water mark based on ALL fetched tasks,
        // not only the ones that pass filtering. Otherwise tasks filtered out
        // by `tagsToSkip` would indefinitely hold the checkpoint behind them
        // and force re-fetching the same window every run. Matches Jira's
        // `buildBatch` pattern which advances on the last fetched issue.
        for (const task of tasks) {
          advanceProgress(progress, task.modified_at);
        }

        const filtered = tasks.filter((task) => {
          // Skip tasks already emitted in this sync (multi-homed across
          // multiple selected projects). Prevents duplicate document yields
          // and redundant stories fetches for the same task.
          if (seenTaskGids.has(task.gid)) {
            return false;
          }
          if (
            bufferedSince &&
            task.modified_at &&
            new Date(task.modified_at) <= bufferedSince
          ) {
            return false;
          }
          return !shouldSkipByTags(
            task.tags?.map((t) => t.name) ?? [],
            config.tagsToSkip,
          );
        });

        const documents: ConnectorDocument[] = [];
        for (const task of filtered) {
          seenTaskGids.add(task.gid);
          const stories = await this.safeItemFetch({
            fetch: () => this.getTaskStories(storiesApi, task.gid),
            fallback: [],
            itemId: task.gid,
            resource: "stories",
          });
          documents.push(taskToDocument(task, stories));
        }

        pageHasMore = nextOffset !== null;
        offset = nextOffset ?? undefined;

        const isFinalBatch = !pageHasMore && isLastProject;

        this.log.debug(
          {
            project: project.name,
            taskCount: tasks.length,
            filteredCount: filtered.length,
            documentCount: documents.length,
            hasMore: !isFinalBatch,
          },
          "Tasks batch fetched",
        );

        // Finalize the checkpoint only on the last page of the last project:
        // this endpoint is not ordered by modified_at, so advancing per batch
        // can skip unseen later pages after an interrupted run.
        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "asana",
            itemUpdatedAt: isFinalBatch ? progress.maxLastModified : undefined,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore: !isFinalBatch,
        };
      } catch (error) {
        this.log.error(
          {
            project: project.name,
            offset,
            error: extractErrorMessage(error),
          },
          "Tasks batch fetch failed",
        );
        throw error;
      }
    }
  }

  private async getTaskStories(
    storiesApi: StoriesApi,
    taskGid: string,
  ): Promise<AsanaStory[]> {
    const raw = await this.paginateAll<AsanaStoryApiRecord>((opts) =>
      storiesApi.getStoriesForTask(taskGid, {
        ...opts,
        opt_fields: STORY_OPT_FIELDS,
      }),
    );
    return raw
      .filter((s) => s.type === "comment" && (s.text || s.html_text))
      .map((s) => ({
        author: s.created_by?.name ?? "unknown",
        // Prefer rich html_text so @mentions and formatting survive; fall
        // back to plain text when the story has no html variant.
        body: s.html_text
          ? extractAsanaHtml(String(s.html_text))
          : String(s.text ?? ""),
        date: s.created_at
          ? new Date(String(s.created_at)).toISOString().slice(0, 10)
          : "",
      }));
  }

  /**
   * Walk Asana's offset-based pagination until the endpoint reports no more
   * pages. Applies `rateLimit()` and 429 retry before every page fetch so
   * throttling and retry are preserved across pages, not only the first one.
   */
  private async paginateAll<T>(
    fetch: (opts: { limit: number; offset?: string }) => Promise<unknown>,
  ): Promise<T[]> {
    const all: T[] = [];
    let offset: string | undefined;

    while (true) {
      await this.rateLimit();
      const result = await this.callWithRetry(() =>
        fetch({ limit: SUB_RESOURCE_PAGE_LIMIT, offset }),
      );
      const page = extractCollectionData<T>(result);
      all.push(...page);

      const nextOffset = extractNextOffset(result);
      if (!nextOffset) break;
      offset = nextOffset;
    }

    return all;
  }

  /**
   * Resolve the set of Asana projects to sync. Uses configured `projectGids`
   * if provided, otherwise lists all accessible projects in the workspace.
   *
   * When `projectGids` are explicit, we also verify each project's
   * `workspace.gid` matches `config.workspaceGid`. The same PAT can see
   * multiple workspaces; without this check a stray project GID could
   * silently pull data from another workspace.
   */
  private async getProjects(
    client: ApiClient,
    config: AsanaConfig,
  ): Promise<AsanaProject[]> {
    const projectsApi = new ProjectsApi(client);

    if (config.projectGids && config.projectGids.length > 0) {
      const projects: AsanaProject[] = [];
      for (const gid of config.projectGids) {
        await this.rateLimit();
        const result = await this.callWithRetry(() =>
          projectsApi.getProject(gid, {
            opt_fields: PROJECT_OPT_FIELDS_WITH_WORKSPACE,
          }),
        );
        const data = unwrapSingle<AsanaProjectWithWorkspace>(result);
        if (!data) {
          throw new Error(`Asana getProject(${gid}) returned no usable data`);
        }
        const projectWorkspaceGid = data.workspace?.gid
          ? String(data.workspace.gid)
          : undefined;

        if (
          projectWorkspaceGid &&
          projectWorkspaceGid !== config.workspaceGid
        ) {
          throw new Error(
            `Asana project ${gid} belongs to workspace ${projectWorkspaceGid}, ` +
              `which does not match the configured workspace ${config.workspaceGid}. ` +
              `Either remove the project from projectGids or change workspaceGid.`,
          );
        }

        projects.push({ gid: String(data.gid), name: String(data.name) });
      }
      return projects;
    }

    const projects: AsanaProject[] = [];
    let offset: string | undefined;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();
      const result = await this.callWithRetry(() =>
        projectsApi.getProjectsForWorkspace(config.workspaceGid, {
          limit: 100,
          ...(offset ? { offset } : {}),
          opt_fields: "gid,name",
        }),
      );

      const data = extractCollectionData<AsanaProject>(result);
      for (const p of data) {
        projects.push({ gid: p.gid, name: p.name });
      }

      const nextOffset = extractNextOffset(result);
      hasMore = nextOffset !== null;
      offset = nextOffset ?? undefined;
    }

    return projects;
  }

  /**
   * Wrap an SDK call with 429 retry. Honors the `Retry-After` header
   * documented by Asana; falls back to exponential backoff when the header
   * is absent or unparseable. Non-429 errors propagate immediately.
   *
   * Asana's JS SDK (v3.1.x) delegates HTTP to superagent and does NOT
   * auto-retry on 429 despite the marketing claim in their rate-limit docs.
   * We implement the contract ourselves.
   */
  private async callWithRetry<T>(
    fn: () => Promise<T>,
    maxAttempts = MAX_RETRY_ATTEMPTS,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        if (!isRateLimitError(err) || attempt >= maxAttempts) throw err;

        const retryAfterSec = extractRetryAfterSec(err);
        const delayMs =
          retryAfterSec !== null
            ? retryAfterSec * 1000
            : calculateBackoffDelay(attempt);

        this.log.warn(
          {
            attempt: attempt + 1,
            maxAttempts,
            retryAfterSec,
            delayMs,
          },
          "Asana 429 — waiting then retrying",
        );
        await sleep(delayMs);
        attempt++;
      }
    }
  }

  // ----- Permission-sync helpers -----

  private initPermissionPass(params: PermissionSyncParams): void {
    this.permAudienceByProjectGid = new Map();
    this.permWorkspaceUsers = null;
    this.permWorkspaceUsersFailed = false;
    this.permDroppedPrincipals = 0;
    this.permResolveMappedEmail = params.resolveMappedEmail ?? null;
  }

  /**
   * Projects whose tasks the content sync ingests, with permission fields,
   * sorted by container key so the resume cursor is monotonic. Mirrors
   * `getProjects`: configured gids are validated against the workspace, else
   * every project the credential can see in the workspace.
   */
  private async getPermissionProjects(
    apis: AsanaPermissionApis,
    config: AsanaConfig,
  ): Promise<AsanaPermissionProject[]> {
    const projects: AsanaPermissionProject[] = [];
    if (config.projectGids && config.projectGids.length > 0) {
      for (const gid of config.projectGids) {
        const project = await this.fetchPermissionProject(apis, gid);
        const projectWorkspaceGid = project.workspace?.gid
          ? String(project.workspace.gid)
          : undefined;
        if (
          projectWorkspaceGid &&
          projectWorkspaceGid !== config.workspaceGid
        ) {
          throw new Error(
            `Asana project ${gid} belongs to workspace ${projectWorkspaceGid}, ` +
              `which does not match the configured workspace ${config.workspaceGid}. ` +
              `Either remove the project from projectGids or change workspaceGid.`,
          );
        }
        projects.push(project);
      }
    } else {
      const listed = await this.paginateAll<AsanaPermissionProject>((opts) =>
        apis.projects.getProjectsForWorkspace(config.workspaceGid, {
          ...opts,
          opt_fields: PERMISSION_PROJECT_OPT_FIELDS,
        }),
      );
      projects.push(...listed);
    }
    return projects.sort((a, b) =>
      compareStrings(projectContainerKey(a.gid), projectContainerKey(b.gid)),
    );
  }

  private async fetchPermissionProject(
    apis: AsanaPermissionApis,
    projectGid: string,
  ): Promise<AsanaPermissionProject> {
    await this.rateLimit();
    const result = await this.callWithRetry(() =>
      apis.projects.getProject(projectGid, {
        opt_fields: PERMISSION_PROJECT_OPT_FIELDS,
      }),
    );
    const data = unwrapSingle<AsanaPermissionProject>(result);
    if (!data?.gid) {
      throw new Error(
        `Asana getProject(${projectGid}) returned no usable data`,
      );
    }
    return data;
  }

  private async *syncProjectPermissionSnapshot(params: {
    apis: AsanaPermissionApis;
    config: AsanaConfig;
    project: AsanaPermissionProject;
    seenTaskGids: Set<string>;
  }): AsyncGenerator<PermissionSnapshotYield> {
    const { apis, config, project, seenTaskGids } = params;
    const containerKey = projectContainerKey(project.gid);

    // Buffer this project's NEW task rows first: the container yield must
    // carry the audience and precede its documents, and a project whose tasks
    // were all claimed by earlier projects still needs its boundary container
    // for the pass's fail-close set-diff. Ids and flags only, never content.
    const tasks: AsanaPermissionTaskRecord[] = [];
    let offset: string | undefined;
    let hasMore = true;
    while (hasMore) {
      await this.rateLimit();
      const result = await this.callWithRetry(() =>
        apis.tasks.getTasksForProject(project.gid, {
          limit: BATCH_SIZE,
          ...(offset ? { offset } : {}),
          opt_fields: PERMISSION_TASK_OPT_FIELDS,
        }),
      );
      for (const task of extractCollectionData<AsanaPermissionTask>(result)) {
        if (!task.gid || seenTaskGids.has(task.gid)) continue;
        seenTaskGids.add(task.gid);
        tasks.push({
          gid: task.gid,
          projectGids: (task.projects ?? [])
            .map((p) => (p?.gid ? String(p.gid) : null))
            .filter((gid): gid is string => gid !== null),
          followerGids: (task.followers ?? [])
            .map((f) => (f?.gid ? String(f.gid) : null))
            .filter((gid): gid is string => gid !== null),
        });
      }
      const nextOffset = extractNextOffset(result);
      hasMore = nextOffset !== null;
      offset = nextOffset ?? undefined;
    }

    if (tasks.length === 0) {
      // An empty-corpus project emits a fail-closed boundary container
      // WITHOUT resolving its audience — nothing references it, the pass only
      // needs the enumeration boundary to fail-close leftover documents.
      yield {
        kind: "container",
        containerKey,
        permissions: emptyPermissions(),
        audienceResolutionFailed: false,
        cursor: containerKey,
      };
      return;
    }

    const audience = await this.resolveProjectAudience(
      apis,
      config,
      project.gid,
      project,
    );
    yield {
      kind: "container",
      containerKey,
      permissions: audience
        ? audienceToPermissions(audience)
        : emptyPermissions(),
      audienceResolutionFailed: audience === null,
      cursor: containerKey,
    };

    const emittedUnionKeys = new Set<string>();
    for (const task of tasks) {
      const exceptionUsers = await this.resolveExceptionEmails(
        apis,
        config,
        task.followerGids,
      );
      const otherProjectGids = [...new Set(task.projectGids)]
        .filter((gid) => gid !== project.gid)
        .sort(compareStrings);
      let taskContainerKey = containerKey;
      if (otherProjectGids.length > 0) {
        // Multi-homed: readable through ANY home project, so the task's
        // container is the union of every home project's audience.
        taskContainerKey = `${containerKey}/multi:${otherProjectGids.join("+")}`;
        if (!emittedUnionKeys.has(taskContainerKey)) {
          emittedUnionKeys.add(taskContainerKey);
          const union = await this.resolveUnionAudience(apis, config, [
            project.gid,
            ...otherProjectGids,
          ]);
          yield {
            kind: "container",
            containerKey: taskContainerKey,
            permissions: union.permissions,
            audienceResolutionFailed: union.resolutionFailed,
            cursor: containerKey,
          };
        }
      }
      yield {
        kind: "document",
        sourceId: `task-${task.gid}`,
        containerKey: taskContainerKey,
        ...(exceptionUsers.length > 0 ? { exceptionUsers } : {}),
        cursor: containerKey,
      };
    }
  }

  /**
   * A project's read audience — every Asana access level can read, so no
   * level filtering. Cached per pass; null = the lookup failed and the
   * caller fail-closes. Membership enumeration runs for public projects too:
   * guests are granted only through explicit memberships, never the
   * workspace audience.
   */
  private async resolveProjectAudience(
    apis: AsanaPermissionApis,
    config: AsanaConfig,
    projectGid: string,
    known?: AsanaPermissionProject,
  ): Promise<AsanaProjectAudience | null> {
    const cached = this.permAudienceByProjectGid.get(projectGid);
    if (cached !== undefined) return cached;

    let audience: AsanaProjectAudience | null = null;
    try {
      const project =
        known ?? (await this.fetchPermissionProject(apis, projectGid));
      const users = new Set<string>();
      const groups = new Set<string>();
      if (project.privacy_setting === "public_to_workspace") {
        groups.add(workspaceMembersGroupId(config.workspaceGid));
      }
      // Deprecated privacy value predating team project-memberships: the
      // project is shared with its own team without a membership row.
      if (project.privacy_setting === "private_to_team" && project.team?.gid) {
        groups.add(teamGroupId(String(project.team.gid)));
      }
      const memberships = await this.paginateAll<AsanaProjectMembershipRecord>(
        (opts) =>
          apis.projectMemberships.getProjectMembershipsForProject(projectGid, {
            ...opts,
            opt_fields: PROJECT_MEMBERSHIP_OPT_FIELDS,
          }),
      );
      for (const membership of memberships) {
        const member = membership.member;
        if (!member?.gid) continue;
        if (member.resource_type === "team") {
          groups.add(teamGroupId(String(member.gid)));
          continue;
        }
        const email = await this.resolvePrincipalEmail(
          apis,
          config,
          String(member.gid),
        );
        if (email) {
          users.add(email);
        } else {
          this.permDroppedPrincipals += 1;
        }
      }
      audience = { users, groups };
    } catch (error) {
      this.log.warn(
        { projectGid, error: extractErrorMessage(error) },
        "Could not resolve an Asana project audience; its documents fail-close this pass",
      );
      audience = null;
    }
    this.permAudienceByProjectGid.set(projectGid, audience);
    return audience;
  }

  /**
   * Union audience of a multi-homed task's home projects.
   * `resolutionFailed` only when EVERY lookup failed (the audience is empty
   * because of failures); a partial failure under-grants — the fail-closed
   * direction — and each failed project is logged by
   * `resolveProjectAudience`.
   */
  private async resolveUnionAudience(
    apis: AsanaPermissionApis,
    config: AsanaConfig,
    projectGids: string[],
  ): Promise<{ permissions: DocumentPermissions; resolutionFailed: boolean }> {
    const users = new Set<string>();
    const groups = new Set<string>();
    let anyResolved = false;
    let anyFailed = false;
    for (const gid of projectGids) {
      const audience = await this.resolveProjectAudience(apis, config, gid);
      if (!audience) {
        anyFailed = true;
        continue;
      }
      anyResolved = true;
      for (const user of audience.users) users.add(user);
      for (const group of audience.groups) groups.add(group);
    }
    return {
      permissions: {
        isPublic: false,
        users: [...users].sort(),
        groups: [...groups].sort(),
      },
      resolutionFailed: anyFailed && !anyResolved,
    };
  }

  /** Follower emails for per-document exception grants (sorted, deduped). */
  private async resolveExceptionEmails(
    apis: AsanaPermissionApis,
    config: AsanaConfig,
    userGids: string[],
  ): Promise<string[]> {
    const emails = new Set<string>();
    for (const gid of new Set(userGids)) {
      const email = await this.resolvePrincipalEmail(apis, config, gid);
      if (email) {
        emails.add(email);
      } else {
        this.permDroppedPrincipals += 1;
      }
    }
    return [...emails].sort();
  }

  /**
   * Upstream email first (the workspace user walk exposes emails to any
   * workspace member), the admin's manual member mapping as fallback —
   * matches the Jira/OneDrive exception-grant precedence.
   */
  private async resolvePrincipalEmail(
    apis: AsanaPermissionApis,
    config: AsanaConfig,
    userGid: string,
  ): Promise<string | null> {
    const users = await this.getWorkspaceUsers(apis, config, {
      required: false,
    });
    const upstream = users.get(userGid)?.email ?? null;
    return upstream ?? this.permResolveMappedEmail?.(userGid) ?? null;
  }

  /**
   * One workspace user walk per pass resolves every member/follower email
   * (guests included — they matter for team rosters and direct grants). When
   * `required`, a failed walk throws (group rosters must never replace
   * resolved emails with nulls); otherwise the failure is remembered and
   * direct grants fall back to the admin mapping or fail-closed while
   * group-based audiences stay usable.
   */
  private async getWorkspaceUsers(
    apis: AsanaPermissionApis,
    config: AsanaConfig,
    { required }: { required: boolean },
  ): Promise<Map<string, AsanaWorkspaceUserInfo>> {
    if (this.permWorkspaceUsers) return this.permWorkspaceUsers;
    if (this.permWorkspaceUsersFailed && !required) {
      return new Map();
    }
    try {
      const users = await this.paginateAll<AsanaWorkspaceUser>((opts) =>
        apis.users.getUsers({
          ...opts,
          workspace: config.workspaceGid,
          opt_fields: WORKSPACE_USER_OPT_FIELDS,
        }),
      );
      const map = new Map<string, AsanaWorkspaceUserInfo>();
      for (const user of users) {
        if (!user.gid) continue;
        map.set(String(user.gid), {
          email: user.email ?? null,
          name: user.name ?? null,
        });
      }
      this.permWorkspaceUsers = map;
      return map;
    } catch (error) {
      this.permWorkspaceUsersFailed = true;
      this.log.warn(
        {
          workspaceGid: config.workspaceGid,
          error: extractErrorMessage(error),
        },
        "Could not enumerate Asana workspace users; direct grants resolve via the admin mapping only this pass",
      );
      if (required) throw error;
      return new Map();
    }
  }

  private async fetchWorkspaceName(
    apis: AsanaPermissionApis,
    config: AsanaConfig,
  ): Promise<string> {
    try {
      await this.rateLimit();
      const result = await this.callWithRetry(() =>
        apis.workspaces.getWorkspace(config.workspaceGid, {
          opt_fields: "name",
        }),
      );
      const data = unwrapSingle<{ name?: string | null }>(result);
      if (data?.name) return String(data.name);
    } catch (error) {
      this.log.warn(
        {
          workspaceGid: config.workspaceGid,
          error: extractErrorMessage(error),
        },
        "Could not read the Asana workspace name; using the gid",
      );
    }
    return `Workspace ${config.workspaceGid}`;
  }

  /** Surface principals dropped this pass (fail-closed under-grant). */
  private reportDroppedPermissionPrincipals(): void {
    if (this.permDroppedPrincipals <= 0) return;
    const count = this.permDroppedPrincipals;
    this.permDroppedPrincipals = 0;
    this.log.debug(
      { count, connectorType: this.type },
      "Dropped Asana principals that could not be resolved (fail-closed)",
    );
    metrics.rag.reportPermissionSyncDroppedPrincipals({
      connectorType: this.type,
      reason: "no_email",
      count,
    });
  }
}

// ===== Module-level helpers =====

interface SyncProgress {
  /** Highest `modified_at` seen across all projects/pages during this sync. */
  maxLastModified: string | undefined;
}

/** Advance the monotonic high-water mark forward only. */
function advanceProgress(
  progress: SyncProgress,
  candidate: string | null | undefined,
): void {
  if (!candidate) return;
  if (!progress.maxLastModified || candidate > progress.maxLastModified) {
    progress.maxLastModified = candidate;
  }
}

interface AsanaProject {
  gid: string;
  name: string;
}

interface AsanaTask {
  gid: string;
  name: string;
  notes: string;
  html_notes?: string;
  completed: boolean;
  modified_at: string;
  created_at: string;
  permalink_url: string;
  assignee?: { name: string } | null;
  projects?: Array<{ name: string }>;
  tags?: Array<{ name: string }>;
}

interface AsanaStory {
  author: string;
  body: string;
  date: string;
}

// ===== Asana API response shapes =====
// Partial — only fields we actually read. Asana SDK v3.x returns Collection /
// response wrappers that aren't usefully typed, so we describe the minimum
// surface and narrow unknown responses via runtime guards.

interface AsanaProjectWithWorkspace extends AsanaProject {
  workspace?: { gid?: string } | null;
}

interface AsanaStoryApiRecord {
  type?: string;
  text?: string | null;
  html_text?: string | null;
  created_by?: { name?: string | null } | null;
  created_at?: string | null;
}

// ===== Superagent error shape (partial) =====
// Asana SDK delegates HTTP to superagent; header access varies across versions
// so we check both `headers` and `header`.

interface SuperagentHeadersLike {
  [key: string]: string | string[] | undefined;
}

interface SuperagentResponseLike {
  status?: number;
  headers?: SuperagentHeadersLike;
  header?: SuperagentHeadersLike;
}

interface SuperagentErrorLike {
  status?: number;
  response?: SuperagentResponseLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createAsanaClient(credentials: ConnectorCredentials): ApiClient {
  const client = new ApiClient();
  client.authentications.token = {
    type: "personalAccessToken",
    accessToken: credentials.apiToken,
  };
  return client;
}

function parseAsanaConfig(config: Record<string, unknown>): AsanaConfig | null {
  const result = AsanaConfigSchema.safeParse({ type: "asana", ...config });
  return result.success ? result.data : null;
}

function shouldSkipByTags(taskTags: string[], tagsToSkip?: string[]): boolean {
  if (!tagsToSkip || tagsToSkip.length === 0) return false;
  return taskTags.some((tag) => tagsToSkip.includes(tag));
}

function extractCollectionData<T>(result: unknown): T[] {
  if (isRecord(result) && Array.isArray(result.data)) {
    return result.data as T[];
  }
  if (Array.isArray(result)) {
    return result as T[];
  }
  return [];
}

function extractNextOffset(result: unknown): string | null {
  if (!isRecord(result)) return null;
  // Collection-wrapped responses expose `next_page` on `_response`; some paths
  // put it on the root. Check both.
  const viaResponse = isRecord(result._response)
    ? result._response.next_page
    : undefined;
  const nextPage = isRecord(viaResponse)
    ? viaResponse
    : isRecord(result.next_page)
      ? result.next_page
      : null;
  if (!nextPage) return null;
  const offset = nextPage.offset;
  return typeof offset === "string" && offset.length > 0 ? offset : null;
}

/**
 * Single-object responses can arrive either wrapped (`{ data: {...} }`) or
 * already unwrapped depending on the SDK call. Return the inner record.
 */
function unwrapSingle<T>(result: unknown): T | undefined {
  if (!isRecord(result)) return undefined;
  const data = result.data;
  if (isRecord(data)) return data as T;
  return result as T;
}

/**
 * Extract readable text from Asana's rich-text HTML (html_notes / html_text).
 *
 * Asana uses a small controlled tag set: <body>, <strong>, <em>, <u>, <s>,
 * <code>, <pre>, <a>, <ul>, <ol>, <li>, <h1>, <h2>, <blockquote>.
 * @-mentions appear as `<a data-asana-gid="...">` often with EMPTY text;
 * we preserve a marker `[@asana:gid]` so the reference is not silently lost.
 * @public — exported for testability
 */
export function extractAsanaHtml(html: string): string {
  if (!html) return "";
  const $ = cheerio.load(html, { xml: { xmlMode: false } });

  // Rewrite empty Asana anchors with a marker before text extraction.
  $("a").each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    const asanaGid = $el.attr("data-asana-gid");
    if (!text && asanaGid) {
      $el.text(`[@asana:${asanaGid}]`);
    }
  });

  // List items get "- " prefix; preserve newlines between block-level tags.
  $("li").each((_, el) => {
    const $el = $(el);
    $el.prepend("- ");
    $el.append("\n");
  });
  $("br").replaceWith("\n");
  $("p, h1, h2, h3, blockquote, pre").each((_, el) => {
    const $el = $(el);
    $el.append("\n");
  });

  const text = $.root().text();
  // Normalize: collapse 3+ newlines, trim trailing whitespace per line.
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Check whether an error is an Asana 429 response. Asana's SDK uses
 * superagent which exposes `err.status` and `err.response`.
 */
function isRateLimitError(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const e = err as SuperagentErrorLike;
  if (e.status === 429) return true;
  return e.response?.status === 429;
}

/**
 * Read `Retry-After` (seconds) from a superagent-style error. Header access
 * varies across superagent versions so we check both `headers` and `header`.
 * Returns null if the header is missing or unparseable.
 */
function extractRetryAfterSec(err: unknown): number | null {
  if (!isRecord(err)) return null;
  const e = err as SuperagentErrorLike;
  const raw =
    e.response?.headers?.["retry-after"] ??
    e.response?.header?.["retry-after"] ??
    null;
  if (raw == null) return null;
  // HTTP headers can be string or string[]; take the first.
  const rawStr = Array.isArray(raw) ? raw[0] : raw;
  if (rawStr === undefined) return null;
  const seconds = Number(rawStr);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // Asana docs always send seconds; defensive default for unexpected formats.
  return DEFAULT_RETRY_AFTER_SEC;
}

function calculateBackoffDelay(attempt: number): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * 0.25 * exponential;
  return Math.min(exponential + jitter, RETRY_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskToDocument(
  task: AsanaTask,
  stories: AsanaStory[],
): ConnectorDocument {
  // Prefer rich html_notes so formatting and @mentions survive; fall back to
  // plain notes when the task has no html variant.
  const descriptionText = task.html_notes
    ? extractAsanaHtml(task.html_notes)
    : (task.notes ?? "");

  const contentParts = [`# Task: ${task.name}`, "", descriptionText];

  const nonEmptyStories = stories.filter((s) => s.body.trim());
  if (nonEmptyStories.length > 0) {
    contentParts.push("", "## Comments", "");
    for (const s of nonEmptyStories) {
      contentParts.push(`**${s.author}** (${s.date}): ${s.body}`);
    }
  }

  // Asana task `gid` is globally unique across the workspace. Tasks can be
  // multi-homed in several projects, so a task-scoped id prevents duplicate
  // indexing when the same task appears under different selected projects.
  return {
    id: `task-${task.gid}`,
    title: task.name,
    content: contentParts.join("\n"),
    sourceUrl: task.permalink_url,
    metadata: {
      taskGid: task.gid,
      completed: task.completed,
      projects: task.projects?.map((p) => p.name) ?? [],
      assignee: task.assignee?.name,
      tags: task.tags?.map((t) => t.name) ?? [],
    },
    updatedAt: task.modified_at ? new Date(task.modified_at) : undefined,
  };
}

// ===== Permission-sync module helpers =====

interface AsanaPermissionApis {
  projects: ProjectsApi;
  projectMemberships: ProjectMembershipsApi;
  tasks: TasksApi;
  teams: TeamsApi;
  teamMemberships: TeamMembershipsApi;
  workspaceMemberships: WorkspaceMembershipsApi;
  workspaces: WorkspacesApi;
  users: UsersApi;
}

function createPermissionApis(
  credentials: ConnectorCredentials,
): AsanaPermissionApis {
  const client = createAsanaClient(credentials);
  return {
    projects: new ProjectsApi(client),
    projectMemberships: new ProjectMembershipsApi(client),
    tasks: new TasksApi(client),
    teams: new TeamsApi(client),
    teamMemberships: new TeamMembershipsApi(client),
    workspaceMemberships: new WorkspaceMembershipsApi(client),
    workspaces: new WorkspacesApi(client),
    users: new UsersApi(client),
  };
}

interface AsanaProjectAudience {
  users: Set<string>;
  groups: Set<string>;
}

interface AsanaWorkspaceUserInfo {
  email: string | null;
  name: string | null;
}

// Partial Asana API response shapes for the permission pass (same convention
// as the content-sync shapes above: only fields we actually read).

interface AsanaPermissionProject {
  gid: string;
  name?: string | null;
  privacy_setting?: string | null;
  team?: { gid?: string | null } | null;
  workspace?: { gid?: string | null } | null;
}

interface AsanaPermissionTask {
  gid?: string;
  projects?: Array<{ gid?: string | null } | null> | null;
  followers?: Array<{ gid?: string | null } | null> | null;
}

interface AsanaPermissionTaskRecord {
  gid: string;
  projectGids: string[];
  followerGids: string[];
}

interface AsanaProjectMembershipRecord {
  member?: { gid?: string | null; resource_type?: string | null } | null;
}

interface AsanaWorkspaceMembershipRecord {
  user?: { gid?: string | null; name?: string | null } | null;
  is_guest?: boolean;
  is_active?: boolean;
}

interface AsanaTeamRecord {
  gid: string;
  name?: string | null;
}

interface AsanaTeamMembershipRecord {
  user?: { gid?: string | null; name?: string | null } | null;
  is_limited_access?: boolean;
}

interface AsanaWorkspaceUser {
  gid?: string;
  email?: string | null;
  name?: string | null;
}

function projectContainerKey(projectGid: string): string {
  return `project:${projectGid}`;
}

/** Asana gids are globally unique → distinct across connectors of one type. */
function teamGroupId(teamGid: string): string {
  return `team:${teamGid}`;
}

function workspaceMembersGroupId(workspaceGid: string): string {
  return `workspace-members:${workspaceGid}`;
}

function emptyPermissions(): DocumentPermissions {
  return { isPublic: false, users: [], groups: [] };
}

function audienceToPermissions(
  audience: AsanaProjectAudience,
): DocumentPermissions {
  return {
    isPublic: false,
    users: [...audience.users].sort(),
    groups: [...audience.groups].sort(),
  };
}

/** Byte-order comparator matching the pass's plain `<` cursor comparisons. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 403/404 from Asana: the credential cannot read the resource. */
function isPermissionDeniedError(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const e = err as SuperagentErrorLike;
  const status = e.status ?? e.response?.status;
  return status === 403 || status === 404;
}
