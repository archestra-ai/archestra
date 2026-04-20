import { LinearClient } from "@linear/sdk";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorItemFailure,
  ConnectorSyncBatch,
  LinearCheckpoint,
  LinearConfig,
} from "@/types";
import { LinearConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const DEFAULT_LINEAR_API_URL = "https://api.linear.app";

/** Clock skew buffer when lower bound comes from a normalized `lastSyncedAt` only. */
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

const ISSUES_QUERY = `
  query LinearIssues($first: Int!, $after: String, $filter: IssueFilter) {
    issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        description
        url
        updatedAt
        state {
          name
        }
        team {
          key
          name
        }
        project {
          id
          name
        }
        labels {
          nodes {
            name
          }
        }
        comments(first: 50) {
          pageInfo {
            hasNextPage
          }
          nodes {
            body
            createdAt
            user {
              name
            }
          }
        }
      }
    }
  }
`;

const ISSUES_QUERY_NO_COMMENTS = `
  query LinearIssues($first: Int!, $after: String, $filter: IssueFilter) {
    issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        description
        url
        updatedAt
        state {
          name
        }
        team {
          key
          name
        }
        project {
          id
          name
        }
        labels {
          nodes {
            name
          }
        }
      }
    }
  }
`;

const PROJECTS_QUERY = `
  query LinearProjects($first: Int!, $after: String, $filter: ProjectFilter) {
    projects(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        description
        content
        url
        updatedAt
        state
        projectUpdates(first: 15) {
          pageInfo {
            hasNextPage
          }
          nodes {
            body
            createdAt
            url
            user {
              name
            }
          }
        }
      }
    }
  }
`;

const CYCLES_QUERY = `
  query LinearCycles($first: Int!, $after: String, $filter: CycleFilter) {
    cycles(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        description
        number
        updatedAt
        startsAt
        endsAt
        completedAt
        isActive
        team {
          key
          name
        }
      }
    }
  }
`;

type LinearSyncPhase = "issues" | "projects" | "cycles";
type LinearPageInfo = { hasNextPage: boolean; endCursor: string | null };
type LinearLabelNode = { name?: string };
type LinearIssueCommentNode = {
  body?: string;
  createdAt?: string;
  user?: { name?: string };
};
type LinearIssueNode = {
  id: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  updatedAt?: string;
  state?: { name?: string };
  team?: { key?: string; name?: string };
  project?: { id?: string; name?: string } | null;
  labels?: { nodes?: LinearLabelNode[] };
  comments?: { pageInfo?: LinearPageInfo; nodes?: LinearIssueCommentNode[] };
};
type LinearProjectUpdateNode = {
  body?: string;
  createdAt?: string;
  url?: string;
  user?: { name?: string };
};
type LinearProjectNode = {
  id: string;
  name?: string;
  description?: string;
  content?: string;
  url?: string;
  updatedAt?: string;
  state?: string;
  projectUpdates?: {
    pageInfo?: LinearPageInfo;
    nodes?: LinearProjectUpdateNode[];
  };
};
type LinearCycleNode = {
  id: string;
  name?: string;
  description?: string;
  number?: number;
  updatedAt?: string;
  startsAt?: string;
  endsAt?: string;
  completedAt?: string;
  isActive?: boolean;
  team?: { key?: string; name?: string };
};
type LinearIssuesQueryData = {
  issues?: { pageInfo?: LinearPageInfo; nodes?: LinearIssueNode[] };
};
type LinearProjectsQueryData = {
  projects?: { pageInfo?: LinearPageInfo; nodes?: LinearProjectNode[] };
};
type LinearCyclesQueryData = {
  cycles?: { pageInfo?: LinearPageInfo; nodes?: LinearCycleNode[] };
};

export class LinearConnector extends BaseConnector {
  type = "linear" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseLinearConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid Linear configuration: linearApiUrl (string) is required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.linearApiUrl)) {
      return {
        valid: false,
        error: "linearApiUrl must be a valid HTTP(S) URL",
      };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseLinearConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Linear configuration" };
    }

    try {
      const client = createLinearClient(
        params.credentials.apiToken,
        parsed.linearApiUrl,
      );

      const viewer = await client.viewer;
      if (!viewer?.id) {
        return {
          success: false,
          error: "Connection failed: unable to resolve viewer from Linear API",
        };
      }

      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Linear connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseLinearConfig(params.config);
    if (!parsed) return null;
    // Linear GraphQL schemas differ across workspaces and may not expose a
    // stable count field on issue connections/search. Returning null avoids
    // noisy run-level warnings while sync continues normally.
    void params.credentials;
    void params.checkpoint;
    return null;
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseLinearConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Linear configuration");
    }

    let cp: LinearCheckpoint = {
      type: "linear",
      ...(params.checkpoint as LinearCheckpoint | null),
    };

    // Capture the lastSyncedAt value from the start of this run before any
    // phase advances it. Projects and cycles use this as their fallback lower
    // bound so that they are not inadvertently anchored to the watermark that
    // the issues phase writes during the current run.
    const initialLastSyncedAt = cp.lastSyncedAt;

    const includeProjects = parsed.includeProjects === true;
    const includeCycles = parsed.includeCycles === true;

    // Determine the starting phase while applying current feature-flag state.
    // This must be done once here and re-applied after each phase completes so
    // that a checkpoint left at "projects" while includeProjects is now off
    // does not permanently block subsequent phases.
    let phase: LinearSyncPhase = applyFeatureFlags(
      cp.linearSyncPhase ?? "issues",
      includeProjects,
      includeCycles,
    );

    if (phase === "issues") {
      yield* this.syncIssuesPhase({
        config: parsed,
        credentials: params.credentials,
        initialLastSyncedAt,
        getCheckpoint: () => cp,
        setCheckpoint: (next) => {
          cp = next;
        },
      });
      // Re-derive phase from the updated checkpoint, then re-apply feature flags.
      phase = applyFeatureFlags(
        cp.linearSyncPhase ?? "issues",
        includeProjects,
        includeCycles,
      );
    }

    if (phase === "projects") {
      yield* this.syncProjectsPhase({
        config: parsed,
        credentials: params.credentials,
        initialLastSyncedAt,
        getCheckpoint: () => cp,
        setCheckpoint: (next) => {
          cp = next;
        },
      });
      // Re-derive phase from the updated checkpoint, then re-apply feature flags.
      phase = applyFeatureFlags(
        cp.linearSyncPhase ?? phase,
        includeProjects,
        includeCycles,
      );
    }

    if (phase === "cycles") {
      yield* this.syncCyclesPhase({
        config: parsed,
        credentials: params.credentials,
        initialLastSyncedAt,
        getCheckpoint: () => cp,
        setCheckpoint: (next) => {
          cp = next;
        },
      });
    }
  }

  private async *syncIssuesPhase(params: {
    config: LinearConfig;
    credentials: ConnectorCredentials;
    initialLastSyncedAt: string | undefined;
    getCheckpoint: () => LinearCheckpoint;
    setCheckpoint: (cp: LinearCheckpoint) => void;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      config,
      credentials,
      initialLastSyncedAt,
      getCheckpoint,
      setCheckpoint,
    } = params;

    const client = createLinearClient(
      credentials.apiToken,
      config.linearApiUrl,
    );
    const batchSize = config.batchSize ?? 50;
    const query =
      config.includeComments === false
        ? ISSUES_QUERY_NO_COMMENTS
        : ISSUES_QUERY;

    let prev = getCheckpoint();
    const issueUpdatedAfter = resolveIssueSweepLowerBound(
      prev,
      initialLastSyncedAt,
    );
    let cursor: string | null | undefined = prev.issuePageCursor;
    let hasMoreIssues = true;
    let maxIssueUpdated: string | undefined = prev.lastRawUpdatedAt;

    while (hasMoreIssues) {
      await this.rateLimit();

      const filter = buildIssueFilterForSweep({
        config,
        issueUpdatedAfter,
      });

      const variables: Record<string, unknown> = {
        first: batchSize,
        after: cursor ?? null,
      };
      if (filter) variables.filter = filter;

      const payload = await linearRawRequest<LinearIssuesQueryData>(
        client,
        query,
        variables,
      );

      const conn = payload.issues;
      if (!conn) {
        throw new Error("Linear GraphQL: missing issues connection");
      }

      const issues = conn.nodes ?? [];
      const pageInfo = conn.pageInfo ?? {
        hasNextPage: false,
        endCursor: null,
      };

      const documents: ConnectorDocument[] = [];
      const batchFailures: ConnectorItemFailure[] = [];
      for (const issue of issues) {
        if (issue.comments?.pageInfo?.hasNextPage) {
          this.log.warn(
            { issueId: issue.id },
            "Linear issue has more than 50 comments; truncating.",
          );
        }
        try {
          const doc = issueNodeToDocument(issue, config);
          documents.push(doc);
          maxIssueUpdated = maxIsoString(maxIssueUpdated, issue.updatedAt);
        } catch (error) {
          this.log.warn(
            {
              issueId: issue?.id,
              error: extractErrorMessage(error),
            },
            "Skipping Linear issue after mapping failure",
          );
          batchFailures.push({
            itemId: String(issue?.id ?? "unknown"),
            resource: "linear.issue",
            error: extractErrorMessage(error),
          });
        }
      }

      hasMoreIssues = !!pageInfo.hasNextPage;
      cursor = pageInfo.endCursor ?? null;

      prev = getCheckpoint();
      const base = buildCheckpoint({
        type: "linear",
        itemUpdatedAt:
          issues.length > 0 ? issues[issues.length - 1].updatedAt : null,
        previousLastSyncedAt: prev.lastSyncedAt,
        extra: {},
      });

      const nextCheckpoint: LinearCheckpoint = {
        type: "linear",
        lastSyncedAt: maxIsoString(base.lastSyncedAt, prev.lastSyncedAt),
        lastRawUpdatedAt: hasMoreIssues
          ? prev.lastRawUpdatedAt
          : maxIsoString(maxIssueUpdated, prev.lastRawUpdatedAt),
        linearSyncPhase: hasMoreIssues
          ? "issues"
          : includeProjectsOrCycles(config),
        issuePageCursor: hasMoreIssues ? (cursor ?? undefined) : undefined,
        issueUpdatedAfter: hasMoreIssues ? issueUpdatedAfter : undefined,
        projectLastRawUpdatedAt: prev.projectLastRawUpdatedAt,
        projectPageCursor: prev.projectPageCursor,
        projectUpdatedAfter: prev.projectUpdatedAfter,
        cycleLastRawUpdatedAt: prev.cycleLastRawUpdatedAt,
        cyclePageCursor: prev.cyclePageCursor,
        cycleUpdatedAfter: prev.cycleUpdatedAfter,
      };

      setCheckpoint(nextCheckpoint);

      const moreWorkAfterIssues =
        config.includeProjects === true || config.includeCycles === true;

      yield {
        documents,
        failures: [...batchFailures, ...this.flushFailures()],
        checkpoint: nextCheckpoint,
        hasMore: hasMoreIssues || (!hasMoreIssues && moreWorkAfterIssues),
      };
    }
  }

  private async *syncProjectsPhase(params: {
    config: LinearConfig;
    credentials: ConnectorCredentials;
    initialLastSyncedAt: string | undefined;
    getCheckpoint: () => LinearCheckpoint;
    setCheckpoint: (cp: LinearCheckpoint) => void;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      config,
      credentials,
      initialLastSyncedAt,
      getCheckpoint,
      setCheckpoint,
    } = params;

    const client = createLinearClient(
      credentials.apiToken,
      config.linearApiUrl,
    );
    const batchSize = config.batchSize ?? 50;

    let prev = getCheckpoint();
    const projectUpdatedAfter = resolveProjectSweepLowerBound(
      prev,
      initialLastSyncedAt,
    );
    let cursor: string | null | undefined = prev.projectPageCursor;
    let hasMore = true;
    let maxProjectUpdated: string | undefined = prev.projectLastRawUpdatedAt;

    while (hasMore) {
      await this.rateLimit();

      const filter = buildProjectFilterForSweep({
        config,
        projectUpdatedAfter,
      });

      const variables: Record<string, unknown> = {
        first: batchSize,
        after: cursor ?? null,
      };
      if (filter) variables.filter = filter;

      const payload = await linearRawRequest<LinearProjectsQueryData>(
        client,
        PROJECTS_QUERY,
        variables,
      );

      const conn = payload.projects;
      if (!conn) {
        throw new Error("Linear GraphQL: missing projects connection");
      }

      const projects = conn.nodes ?? [];
      const pageInfo = conn.pageInfo ?? {
        hasNextPage: false,
        endCursor: null,
      };

      const documents: ConnectorDocument[] = [];
      const batchFailures: ConnectorItemFailure[] = [];
      for (const project of projects) {
        if (project.projectUpdates?.pageInfo?.hasNextPage) {
          this.log.warn(
            { projectId: project.id },
            "Linear project has more than 15 updates; truncating.",
          );
        }
        try {
          documents.push(projectNodeToDocument(project));
          maxProjectUpdated = maxIsoString(
            maxProjectUpdated,
            project.updatedAt,
          );
        } catch (error) {
          this.log.warn(
            {
              projectId: project?.id,
              error: extractErrorMessage(error),
            },
            "Skipping Linear project after mapping failure",
          );
          batchFailures.push({
            itemId: String(project?.id ?? "unknown"),
            resource: "linear.project",
            error: extractErrorMessage(error),
          });
        }
      }

      hasMore = !!pageInfo.hasNextPage;
      cursor = pageInfo.endCursor ?? null;

      prev = getCheckpoint();
      const base = buildCheckpoint({
        type: "linear",
        itemUpdatedAt:
          projects.length > 0 ? projects[projects.length - 1].updatedAt : null,
        previousLastSyncedAt: prev.lastSyncedAt,
        extra: {},
      });

      const nextCheckpoint: LinearCheckpoint = {
        type: "linear",
        lastSyncedAt: maxIsoString(base.lastSyncedAt, prev.lastSyncedAt),
        lastRawUpdatedAt: prev.lastRawUpdatedAt,
        linearSyncPhase: hasMore
          ? "projects"
          : config.includeCycles === true
            ? "cycles"
            : "issues",
        issuePageCursor: undefined,
        issueUpdatedAfter: undefined,
        projectLastRawUpdatedAt: hasMore
          ? prev.projectLastRawUpdatedAt
          : maxIsoString(maxProjectUpdated, prev.projectLastRawUpdatedAt),
        projectPageCursor: hasMore ? (cursor ?? undefined) : undefined,
        projectUpdatedAfter: hasMore ? projectUpdatedAfter : undefined,
        cycleLastRawUpdatedAt: prev.cycleLastRawUpdatedAt,
        cyclePageCursor: prev.cyclePageCursor,
        cycleUpdatedAfter: prev.cycleUpdatedAfter,
      };

      setCheckpoint(nextCheckpoint);

      yield {
        documents,
        failures: [...batchFailures, ...this.flushFailures()],
        checkpoint: nextCheckpoint,
        hasMore: hasMore || config.includeCycles === true,
      };
    }
  }

  private async *syncCyclesPhase(params: {
    config: LinearConfig;
    credentials: ConnectorCredentials;
    initialLastSyncedAt: string | undefined;
    getCheckpoint: () => LinearCheckpoint;
    setCheckpoint: (cp: LinearCheckpoint) => void;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const {
      config,
      credentials,
      initialLastSyncedAt,
      getCheckpoint,
      setCheckpoint,
    } = params;

    const client = createLinearClient(
      credentials.apiToken,
      config.linearApiUrl,
    );
    const batchSize = config.batchSize ?? 50;

    let prev = getCheckpoint();
    const cycleUpdatedAfter = resolveCycleSweepLowerBound(
      prev,
      initialLastSyncedAt,
    );
    let cursor: string | null | undefined = prev.cyclePageCursor;
    let hasMore = true;
    let maxCycleUpdated: string | undefined = prev.cycleLastRawUpdatedAt;

    while (hasMore) {
      await this.rateLimit();

      const filter = buildCycleFilterForSweep({
        config,
        cycleUpdatedAfter,
      });

      const variables: Record<string, unknown> = {
        first: batchSize,
        after: cursor ?? null,
      };
      if (filter) variables.filter = filter;

      const payload = await linearRawRequest<LinearCyclesQueryData>(
        client,
        CYCLES_QUERY,
        variables,
      );

      const conn = payload.cycles;
      if (!conn) {
        throw new Error("Linear GraphQL: missing cycles connection");
      }

      const cycles = conn.nodes ?? [];
      const pageInfo = conn.pageInfo ?? {
        hasNextPage: false,
        endCursor: null,
      };

      const documents: ConnectorDocument[] = [];
      const batchFailures: ConnectorItemFailure[] = [];
      for (const cycle of cycles) {
        try {
          documents.push(cycleNodeToDocument(cycle));
          maxCycleUpdated = maxIsoString(maxCycleUpdated, cycle.updatedAt);
        } catch (error) {
          this.log.warn(
            {
              cycleId: cycle?.id,
              error: extractErrorMessage(error),
            },
            "Skipping Linear cycle after mapping failure",
          );
          batchFailures.push({
            itemId: String(cycle?.id ?? "unknown"),
            resource: "linear.cycle",
            error: extractErrorMessage(error),
          });
        }
      }

      hasMore = !!pageInfo.hasNextPage;
      cursor = pageInfo.endCursor ?? null;

      prev = getCheckpoint();
      const base = buildCheckpoint({
        type: "linear",
        itemUpdatedAt:
          cycles.length > 0 ? cycles[cycles.length - 1].updatedAt : null,
        previousLastSyncedAt: prev.lastSyncedAt,
        extra: {},
      });

      const nextCheckpoint: LinearCheckpoint = {
        type: "linear",
        lastSyncedAt: maxIsoString(base.lastSyncedAt, prev.lastSyncedAt),
        lastRawUpdatedAt: prev.lastRawUpdatedAt,
        linearSyncPhase: hasMore ? "cycles" : "issues",
        issuePageCursor: undefined,
        issueUpdatedAfter: undefined,
        projectLastRawUpdatedAt: prev.projectLastRawUpdatedAt,
        projectPageCursor: undefined,
        projectUpdatedAfter: undefined,
        cycleLastRawUpdatedAt: hasMore
          ? prev.cycleLastRawUpdatedAt
          : maxIsoString(maxCycleUpdated, prev.cycleLastRawUpdatedAt),
        cyclePageCursor: hasMore ? (cursor ?? undefined) : undefined,
        cycleUpdatedAfter: hasMore ? cycleUpdatedAfter : undefined,
      };

      setCheckpoint(nextCheckpoint);

      yield {
        documents,
        failures: [...batchFailures, ...this.flushFailures()],
        checkpoint: nextCheckpoint,
        hasMore,
      };
    }
  }
}

// ===== SDK helpers =====

const RAW_REQUEST_MAX_RETRIES = 3;
const RAW_REQUEST_BASE_DELAY_MS = 1_000;
const RAW_REQUEST_MAX_DELAY_MS = 10_000;

/**
 * Create a LinearClient instance from credentials.
 * Uses the official @linear/sdk for auth, client management, and error handling.
 *
 * The SDK expects the full GraphQL endpoint URL (e.g. https://api.linear.app/graphql),
 * but our config stores the base URL. For custom URLs we append `/graphql`.
 */
function createLinearClient(apiToken: string, apiUrl?: string): LinearClient {
  const opts: { apiKey: string; apiUrl?: string } = { apiKey: apiToken };
  if (apiUrl && apiUrl !== DEFAULT_LINEAR_API_URL) {
    // SDK expects the full GraphQL endpoint, config stores the base URL
    const normalized = apiUrl.replace(/\/+$/, "");
    opts.apiUrl = `${normalized}/graphql`;
  }
  return new LinearClient(opts);
}

/**
 * Execute a raw GraphQL query through the LinearClient's internal GraphQL client.
 * This avoids N+1 lazy-loading issues while still leveraging the SDK for auth.
 *
 * Includes retry logic with exponential backoff for transient errors and rate
 * limits, since the SDK does not provide built-in retry.
 */
async function linearRawRequest<T>(
  client: LinearClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= RAW_REQUEST_MAX_RETRIES; attempt++) {
    try {
      const response = await client.client.rawRequest<
        T,
        Record<string, unknown>
      >(query, variables ?? {});

      if (!response.data) {
        throw new Error("Linear GraphQL: empty data");
      }

      return response.data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < RAW_REQUEST_MAX_RETRIES && isRetryableGqlError(error)) {
        const delay = Math.min(
          RAW_REQUEST_BASE_DELAY_MS * 2 ** attempt +
            Math.random() * 0.25 * RAW_REQUEST_BASE_DELAY_MS * 2 ** attempt,
          RAW_REQUEST_MAX_DELAY_MS,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError || new Error("Unknown error during Linear GraphQL request");
}

/** Determine whether a rawRequest error is worth retrying. */
function isRetryableGqlError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("rate") ||
      msg.includes("429") ||
      msg.includes("ratelimit") ||
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("etimedout") ||
      msg.includes("socket") ||
      msg.includes("network") ||
      msg.includes("fetch") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504")
    );
  }
  return false;
}

// ===== Config parsing =====

function parseLinearConfig(
  config: Record<string, unknown>,
): LinearConfig | null {
  const result = LinearConfigSchema.safeParse({
    type: "linear",
    linearApiUrl: DEFAULT_LINEAR_API_URL,
    ...config,
  });
  return result.success ? result.data : null;
}

function includeProjectsOrCycles(config: LinearConfig): LinearSyncPhase {
  if (config.includeProjects === true) return "projects";
  if (config.includeCycles === true) return "cycles";
  return "issues";
}

/**
 * Re-map a checkpoint phase to account for feature flags that may have been
 * toggled since the checkpoint was written. Prevents a stale "projects" phase
 * from blocking cycles when includeProjects has since been disabled.
 */
function applyFeatureFlags(
  phase: LinearSyncPhase,
  includeProjects: boolean,
  includeCycles: boolean,
): LinearSyncPhase {
  if (phase === "projects" && !includeProjects) {
    return includeCycles ? "cycles" : "issues";
  }
  if (phase === "cycles" && !includeCycles) {
    return "issues";
  }
  return phase;
}

/**
 * Resolve the lower-bound timestamp for the issues sweep.
 *
 * Priority:
 *  1. Cursor + stored lower-bound from a mid-page resume.
 *  2. The issues-specific raw watermark from the previous completed run.
 *  3. The lastSyncedAt captured at the start of the current run (before any
 *     phase updates it), minus the safety buffer.
 */
function resolveIssueSweepLowerBound(
  cp: LinearCheckpoint,
  initialLastSyncedAt: string | undefined,
): string | undefined {
  if (cp.issuePageCursor && cp.issueUpdatedAfter) {
    return cp.issueUpdatedAfter;
  }
  if (cp.lastRawUpdatedAt) {
    return cp.lastRawUpdatedAt;
  }
  if (!initialLastSyncedAt) return undefined;
  const d = new Date(initialLastSyncedAt);
  d.setTime(d.getTime() - INCREMENTAL_SAFETY_BUFFER_MS);
  return d.toISOString();
}

/**
 * Resolve the lower-bound timestamp for the projects sweep.
 *
 * Priority:
 *  1. Cursor + stored lower-bound from a mid-page resume.
 *  2. The projects-specific raw watermark from the previous completed run.
 *  3. The lastSyncedAt captured at the start of the current run (before any
 *     phase updates it), minus the safety buffer.
 *
 * Using initialLastSyncedAt rather than the live cp.lastSyncedAt is critical:
 * by the time this function is called, the issues phase has already advanced
 * cp.lastSyncedAt to the newest issue seen. Falling back to that value would
 * cause projects updated between the old watermark and the newest issue to be
 * silently skipped.
 */
function resolveProjectSweepLowerBound(
  cp: LinearCheckpoint,
  initialLastSyncedAt: string | undefined,
): string | undefined {
  if (cp.projectPageCursor && cp.projectUpdatedAfter) {
    return cp.projectUpdatedAfter;
  }
  if (cp.projectLastRawUpdatedAt) {
    return cp.projectLastRawUpdatedAt;
  }
  if (!initialLastSyncedAt) return undefined;
  const d = new Date(initialLastSyncedAt);
  d.setTime(d.getTime() - INCREMENTAL_SAFETY_BUFFER_MS);
  return d.toISOString();
}

/**
 * Resolve the lower-bound timestamp for the cycles sweep.
 *
 * Same rationale as resolveProjectSweepLowerBound: uses initialLastSyncedAt
 * rather than the live cp.lastSyncedAt to avoid skipping cycles that updated
 * during the window covered by the issues phase.
 */
function resolveCycleSweepLowerBound(
  cp: LinearCheckpoint,
  initialLastSyncedAt: string | undefined,
): string | undefined {
  if (cp.cyclePageCursor && cp.cycleUpdatedAfter) {
    return cp.cycleUpdatedAfter;
  }
  if (cp.cycleLastRawUpdatedAt) {
    return cp.cycleLastRawUpdatedAt;
  }
  if (!initialLastSyncedAt) return undefined;
  const d = new Date(initialLastSyncedAt);
  d.setTime(d.getTime() - INCREMENTAL_SAFETY_BUFFER_MS);
  return d.toISOString();
}

function buildIssueFilterForSweep(params: {
  config: LinearConfig;
  issueUpdatedAfter?: string;
}): Record<string, unknown> | undefined {
  const { config, issueUpdatedAfter } = params;
  const filter: Record<string, unknown> = {};

  if (config.teamIds?.length) {
    filter.team = { id: { in: config.teamIds } };
  }
  if (config.projectIds?.length) {
    filter.project = { id: { in: config.projectIds } };
  }
  if (config.states?.length) {
    const stateIds = config.states.filter(isLikelyLinearId);
    const stateNames = config.states.filter((s) => !isLikelyLinearId(s));
    if (stateIds.length > 0 && stateNames.length > 0) {
      filter.or = [
        { state: { id: { in: stateIds } } },
        { state: { name: { in: stateNames } } },
      ];
    } else if (stateIds.length > 0) {
      filter.state = { id: { in: stateIds } };
    } else {
      filter.state = { name: { in: stateNames } };
    }
  }

  if (issueUpdatedAfter) {
    filter.updatedAt = { gt: issueUpdatedAfter };
  }

  return Object.keys(filter).length ? filter : undefined;
}

function buildProjectFilterForSweep(params: {
  config: LinearConfig;
  projectUpdatedAfter?: string;
}): Record<string, unknown> | undefined {
  const { config, projectUpdatedAfter } = params;
  const filter: Record<string, unknown> = {};

  if (config.projectIds?.length) {
    filter.id = { in: config.projectIds };
  }
  if (config.teamIds?.length) {
    filter.accessibleTeams = { id: { in: config.teamIds } };
  }

  if (projectUpdatedAfter) {
    filter.updatedAt = { gt: projectUpdatedAfter };
  }

  return Object.keys(filter).length ? filter : undefined;
}

function buildCycleFilterForSweep(params: {
  config: LinearConfig;
  cycleUpdatedAfter?: string;
}): Record<string, unknown> | undefined {
  const { config, cycleUpdatedAfter } = params;
  const filter: Record<string, unknown> = {};

  if (config.teamIds?.length) {
    filter.team = { id: { in: config.teamIds } };
  }

  if (cycleUpdatedAfter) {
    filter.updatedAt = { gt: cycleUpdatedAfter };
  }

  return Object.keys(filter).length ? filter : undefined;
}

function maxIsoString(
  a?: string | null,
  b?: string | null,
): string | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

function isLikelyLinearId(value: string): boolean {
  // Linear IDs are UUID-like; names like "In Progress" should route to name filter.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function issueNodeToDocument(
  issue: LinearIssueNode,
  config: LinearConfig,
): ConnectorDocument {
  const labels =
    issue.labels?.nodes
      ?.map((l: { name?: string }) => l.name)
      .filter(Boolean) ?? [];

  const metadata: Record<string, unknown> = {
    kind: "issue",
    identifier: issue.identifier,
    state: issue.state?.name,
    teamKey: issue.team?.key,
    team: issue.team?.name,
    projectId: issue.project?.id,
    project: issue.project?.name,
    labels,
  };

  const title =
    issue.identifier && issue.title
      ? `${issue.identifier}: ${issue.title}`
      : (issue.title ?? issue.identifier ?? issue.id);

  const contentParts = [
    `# ${title}`,
    "",
    `State: ${issue.state?.name ?? ""}`,
    `Team: ${issue.team?.name ?? issue.team?.key ?? ""}`,
    `Project: ${issue.project?.name ?? ""}`,
    labels.length > 0 ? `Labels: ${labels.join(", ")}` : "Labels:",
    "",
    issue.description ?? "",
  ];

  if (config.includeComments !== false && issue.comments?.nodes?.length) {
    contentParts.push("", "## Comments", "");
    for (const comment of issue.comments.nodes) {
      const author = comment.user?.name ?? "Unknown";
      const date = comment.createdAt
        ? new Date(comment.createdAt).toISOString().slice(0, 10)
        : "";
      const body = comment.body ?? "";
      if (body.trim()) {
        contentParts.push(`**${author}** (${date}): ${body}`);
      }
    }
  }

  return {
    id: issue.id,
    title,
    content: contentParts.join("\n"),
    sourceUrl: issue.url,
    metadata,
    updatedAt: issue.updatedAt ? new Date(issue.updatedAt) : undefined,
  };
}

function projectNodeToDocument(project: LinearProjectNode): ConnectorDocument {
  const updates = project.projectUpdates?.nodes ?? [];
  const contentParts = [
    `# ${project.name}`,
    "",
    project.description ?? "",
    "",
    project.content ?? "",
  ];

  if (updates.length > 0) {
    contentParts.push("", "## Project updates", "");
    for (const u of updates) {
      const author = u.user?.name ?? "Unknown";
      const date = u.createdAt
        ? new Date(u.createdAt).toISOString().slice(0, 10)
        : "";
      const body = u.body ?? "";
      if (body.trim()) {
        contentParts.push(`**${author}** (${date}): ${body}`);
      }
    }
  }

  return {
    id: `linear-project-${project.id}`,
    title: project.name ?? project.id,
    content: contentParts.join("\n"),
    sourceUrl: project.url,
    metadata: {
      kind: "project",
      state: project.state,
    },
    updatedAt: project.updatedAt ? new Date(project.updatedAt) : undefined,
  };
}

function cycleNodeToDocument(cycle: LinearCycleNode): ConnectorDocument {
  const lines = [
    `# Cycle ${cycle.number ?? ""}: ${cycle.name ?? cycle.id}`,
    "",
    cycle.description ?? "",
    "",
    `Team: ${cycle.team?.name ?? cycle.team?.key ?? ""}`,
    `Starts: ${cycle.startsAt ?? ""}`,
    `Ends: ${cycle.endsAt ?? ""}`,
    `Completed: ${cycle.completedAt ?? ""}`,
    `Active: ${cycle.isActive ?? ""}`,
  ];

  return {
    id: `linear-cycle-${cycle.id}`,
    title: cycle.name ?? `Cycle ${cycle.number ?? cycle.id}`,
    content: lines.join("\n"),
    metadata: {
      kind: "cycle",
      number: cycle.number,
      teamKey: cycle.team?.key,
      team: cycle.team?.name,
    },
    updatedAt: cycle.updatedAt ? new Date(cycle.updatedAt) : undefined,
  };
}
