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

const ISSUE_COUNT_QUERY = `
  query LinearIssueCount($filter: IssueFilter) {
    issueSearch(filter: $filter, first: 1) {
      totalCount
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
  comments?: { nodes?: LinearIssueCommentNode[] };
};
type LinearProjectUpdateNode = {
  body?: string;
  createdAt?: string;
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
  projectUpdates?: { nodes?: LinearProjectUpdateNode[] };
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

    const url = this.joinUrl(parsed.linearApiUrl, "/graphql");

    try {
      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.credentials.apiToken}`,
        },
        body: JSON.stringify({
          query: "query Healthcheck { viewer { id } }",
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${body.slice(0, 300)}`,
        };
      }

      const payload = (await response.json()) as {
        data?: { viewer?: { id?: string } };
        errors?: Array<{ message?: string }>;
      };

      if (payload.errors && payload.errors.length > 0) {
        const firstError =
          payload.errors[0]?.message ?? "Unknown GraphQL error";
        return {
          success: false,
          error: `Connection failed: ${firstError}`,
        };
      }

      if (!payload.data?.viewer?.id) {
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

    const prev = (params.checkpoint as LinearCheckpoint | null) ?? {
      type: "linear" as const,
    };

    try {
      const filter = buildIssueFilterForSweep({
        config: parsed,
        issueUpdatedAfter: resolveIssueSweepLowerBound(prev, undefined),
        forEstimate: true,
      });

      const url = this.joinUrl(parsed.linearApiUrl, "/graphql");
      const data = await this.linearGraphql<{
        issueSearch?: { totalCount?: number };
      }>({
        url,
        apiToken: params.credentials.apiToken,
        query: ISSUE_COUNT_QUERY,
        variables: filter ? { filter } : {},
      });

      const total = data.issueSearch?.totalCount;
      return typeof total === "number" ? total : null;
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Failed to estimate Linear issue count",
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
    const parsed = parseLinearConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Linear configuration");
    }

    let cp: LinearCheckpoint = {
      type: "linear",
      ...(params.checkpoint as LinearCheckpoint | null),
    };

    const includeProjects = parsed.includeProjects === true;
    const includeCycles = parsed.includeCycles === true;

    let phase: LinearSyncPhase = cp.linearSyncPhase ?? "issues";

    if (phase === "issues") {
      yield* this.syncIssuesPhase({
        config: parsed,
        credentials: params.credentials,
        startTime: params.startTime,
        getCheckpoint: () => cp,
        setCheckpoint: (next) => {
          cp = next;
        },
      });
    }

    phase = cp.linearSyncPhase ?? "issues";

    if (phase === "projects" && !includeProjects) {
      phase = includeCycles ? "cycles" : "issues";
    }

    if (phase === "projects" && includeProjects) {
      yield* this.syncProjectsPhase({
        config: parsed,
        credentials: params.credentials,
        startTime: params.startTime,
        getCheckpoint: () => cp,
        setCheckpoint: (next) => {
          cp = next;
        },
      });
    }

    phase = cp.linearSyncPhase ?? phase;

    if (phase === "cycles" && includeCycles) {
      yield* this.syncCyclesPhase({
        config: parsed,
        credentials: params.credentials,
        startTime: params.startTime,
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
    startTime?: Date;
    getCheckpoint: () => LinearCheckpoint;
    setCheckpoint: (cp: LinearCheckpoint) => void;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { config, credentials, startTime, getCheckpoint, setCheckpoint } =
      params;

    const url = this.joinUrl(config.linearApiUrl, "/graphql");
    const batchSize = config.batchSize ?? 50;
    const query =
      config.includeComments === false
        ? ISSUES_QUERY_NO_COMMENTS
        : ISSUES_QUERY;

    let prev = getCheckpoint();
    const issueUpdatedAfter = resolveIssueSweepLowerBound(prev, startTime);
    let cursor: string | null | undefined = prev.issuePageCursor;
    let hasMoreIssues = true;
    let maxIssueUpdated: string | undefined = prev.lastRawUpdatedAt;

    while (hasMoreIssues) {
      await this.rateLimit();

      const filter = buildIssueFilterForSweep({
        config,
        issueUpdatedAfter,
        forEstimate: false,
      });

      const variables: Record<string, unknown> = {
        first: batchSize,
        after: cursor ?? null,
      };
      if (filter) variables.filter = filter;

      const payload = await this.linearGraphql<LinearIssuesQueryData>({
        url,
        apiToken: credentials.apiToken,
        query,
        variables,
      });

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
    startTime?: Date;
    getCheckpoint: () => LinearCheckpoint;
    setCheckpoint: (cp: LinearCheckpoint) => void;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { config, credentials, startTime, getCheckpoint, setCheckpoint } =
      params;

    const url = this.joinUrl(config.linearApiUrl, "/graphql");
    const batchSize = config.batchSize ?? 50;

    let prev = getCheckpoint();
    const projectUpdatedAfter = resolveProjectSweepLowerBound(prev, startTime);
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

      const payload = await this.linearGraphql<LinearProjectsQueryData>({
        url,
        apiToken: credentials.apiToken,
        query: PROJECTS_QUERY,
        variables,
      });

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
    startTime?: Date;
    getCheckpoint: () => LinearCheckpoint;
    setCheckpoint: (cp: LinearCheckpoint) => void;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { config, credentials, startTime, getCheckpoint, setCheckpoint } =
      params;

    const url = this.joinUrl(config.linearApiUrl, "/graphql");
    const batchSize = config.batchSize ?? 50;

    let prev = getCheckpoint();
    const cycleUpdatedAfter = resolveCycleSweepLowerBound(prev, startTime);
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

      const payload = await this.linearGraphql<LinearCyclesQueryData>({
        url,
        apiToken: credentials.apiToken,
        query: CYCLES_QUERY,
        variables,
      });

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

  private async linearGraphql<T>(params: {
    url: string;
    apiToken: string;
    query: string;
    variables?: Record<string, unknown>;
  }): Promise<T> {
    const response = await this.fetchWithRetry(params.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiToken}`,
      },
      body: JSON.stringify({
        query: params.query,
        variables: params.variables ?? {},
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Linear API error: HTTP ${response.status} - ${body.slice(0, 500)}`,
      );
    }

    const payload = (await response.json()) as {
      data?: T;
      errors?: Array<{ message?: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(payload.errors[0]?.message ?? "Linear GraphQL error");
    }

    if (!payload.data) {
      throw new Error("Linear GraphQL: empty data");
    }

    return payload.data;
  }
}

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

function resolveIssueSweepLowerBound(
  cp: LinearCheckpoint,
  startTime?: Date,
): string | undefined {
  if (cp.issuePageCursor && cp.issueUpdatedAfter) {
    return cp.issueUpdatedAfter;
  }
  if (cp.lastRawUpdatedAt) {
    return cp.lastRawUpdatedAt;
  }
  const iso = cp.lastSyncedAt ?? startTime?.toISOString();
  if (!iso) return undefined;
  const d = new Date(iso);
  d.setTime(d.getTime() - INCREMENTAL_SAFETY_BUFFER_MS);
  return d.toISOString();
}

function resolveProjectSweepLowerBound(
  cp: LinearCheckpoint,
  startTime?: Date,
): string | undefined {
  if (cp.projectPageCursor && cp.projectUpdatedAfter) {
    return cp.projectUpdatedAfter;
  }
  if (cp.projectLastRawUpdatedAt) {
    return cp.projectLastRawUpdatedAt;
  }
  const iso = cp.lastSyncedAt ?? startTime?.toISOString();
  if (!iso) return undefined;
  const d = new Date(iso);
  d.setTime(d.getTime() - INCREMENTAL_SAFETY_BUFFER_MS);
  return d.toISOString();
}

function resolveCycleSweepLowerBound(
  cp: LinearCheckpoint,
  startTime?: Date,
): string | undefined {
  if (cp.cyclePageCursor && cp.cycleUpdatedAfter) {
    return cp.cycleUpdatedAfter;
  }
  if (cp.cycleLastRawUpdatedAt) {
    return cp.cycleLastRawUpdatedAt;
  }
  const iso = cp.lastSyncedAt ?? startTime?.toISOString();
  if (!iso) return undefined;
  const d = new Date(iso);
  d.setTime(d.getTime() - INCREMENTAL_SAFETY_BUFFER_MS);
  return d.toISOString();
}

function buildIssueFilterForSweep(params: {
  config: LinearConfig;
  issueUpdatedAfter?: string;
  forEstimate: boolean;
}): Record<string, unknown> | undefined {
  const { config, issueUpdatedAfter, forEstimate } = params;
  const filter: Record<string, unknown> = {};

  if (config.teamIds?.length) {
    filter.team = { id: { in: config.teamIds } };
  }
  if (config.projectIds?.length) {
    filter.project = { id: { in: config.projectIds } };
  }
  if (config.states?.length) {
    filter.state = { name: { in: config.states } };
  }

  if (issueUpdatedAfter) {
    filter.updatedAt = { gt: issueUpdatedAfter };
  }

  if (forEstimate && !issueUpdatedAfter) {
    return Object.keys(filter).length ? filter : undefined;
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
  } else if (config.teamIds?.length) {
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

  const contentParts = [`# ${title}`, "", issue.description ?? ""];

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
