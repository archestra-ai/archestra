import { ApiClient, ProjectsApi, StoriesApi, TasksApi, UsersApi } from "asana";
import * as cheerio from "cheerio";
import type {
  AsanaCheckpoint,
  AsanaConfig,
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
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

export class AsanaConnector extends BaseConnector {
  type = "asana" as const;

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
