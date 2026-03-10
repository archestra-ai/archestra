import {
  ClientType,
  createClient,
  type Version2Client,
  type Version3Client,
} from "jira.js";
import logger from "@/logging";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  JiraCheckpoint,
  JiraConfig,
} from "@/types/knowledge-connector";
import { JiraConfigSchema } from "@/types/knowledge-connector";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const BATCH_SIZE = 50;
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
];

export class JiraConnector extends BaseConnector {
  type = "jira" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseJiraConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid Jira configuration: jiraBaseUrl (string) and isCloud (boolean) are required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.jiraBaseUrl)) {
      return { valid: false, error: "jiraBaseUrl must be a valid HTTP(S) URL" };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseJiraConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Jira configuration" };
    }

    logger.info(
      { baseUrl: parsed.jiraBaseUrl, isCloud: parsed.isCloud },
      "[JiraConnector] Testing connection",
    );

    try {
      if (parsed.isCloud) {
        const client = createV3Client(parsed, params.credentials);
        await client.myself.getCurrentUser();
      } else {
        const client = createV2Client(parsed, params.credentials);
        await client.myself.getCurrentUser();
      }
      logger.info("[JiraConnector] Connection test successful");
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { error: message, ...extractJiraErrorDetails(error) },
        "[JiraConnector] Connection test failed",
      );
      return { success: false, error: `Connection failed: ${message}` };
    }
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

      logger.info({ jql }, "[JiraConnector] Estimating total items");

      // Use classic JQL search with maxResults=0 to get total without fetching issues
      if (parsed.isCloud) {
        const client = createV3Client(parsed, params.credentials);
        const result = await client.issueSearch.searchForIssuesUsingJql({
          jql,
          fields: ["summary"],
          maxResults: 0,
        });
        return result.total ?? null;
      }

      const client = createV2Client(parsed, params.credentials);
      const result = await client.issueSearch.searchForIssuesUsingJql({
        jql,
        fields: ["summary"],
        maxResults: 0,
      });
      return result.total ?? null;
    } catch (error) {
      logger.warn(
        {
          error: extractErrorMessage(error),
          ...extractJiraErrorDetails(error),
        },
        "[JiraConnector] Failed to estimate total items",
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

    logger.info(
      {
        baseUrl: parsed.jiraBaseUrl,
        isCloud: parsed.isCloud,
        projectKey: parsed.projectKey,
        jql,
        checkpoint,
      },
      "[JiraConnector] Starting sync",
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
    const client = createV3Client(config, credentials);
    let nextPageToken: string | undefined;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        logger.debug(
          { batchIndex, nextPageToken },
          "[JiraConnector] Fetching cloud batch",
        );

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

        logger.info(
          {
            batchIndex,
            issueCount: issues.length,
            documentCount: documents.length,
            hasMore,
          },
          "[JiraConnector] Cloud batch fetched",
        );

        batchIndex++;
        yield buildBatch(documents, issues, checkpoint, hasMore);
      } catch (error) {
        logger.error(
          {
            batchIndex,
            host: config.jiraBaseUrl,
            error: extractErrorMessage(error),
            ...extractJiraErrorDetails(error),
          },
          "[JiraConnector] Cloud batch fetch failed",
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
    const client = createV2Client(config, credentials);
    let startAt = 0;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        logger.debug(
          { batchIndex, startAt },
          "[JiraConnector] Fetching server batch",
        );

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

        logger.info(
          {
            batchIndex,
            issueCount: issues.length,
            documentCount: documents.length,
            total: searchResult.total,
            hasMore,
          },
          "[JiraConnector] Server batch fetched",
        );

        batchIndex++;
        yield buildBatch(documents, issues, checkpoint, hasMore);
      } catch (error) {
        logger.error(
          {
            batchIndex,
            host: config.jiraBaseUrl,
            error: extractErrorMessage(error),
            ...extractJiraErrorDetails(error),
          },
          "[JiraConnector] Server batch fetch failed",
        );
        throw error;
      }
    }
  }
}

// ===== Module-level helpers =====

function createV3Client(
  config: JiraConfig,
  credentials: ConnectorCredentials,
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
  }) as unknown as Version3Client;
}

function createV2Client(
  config: JiraConfig,
  credentials: ConnectorCredentials,
): Version2Client {
  return createClient(ClientType.Version2, {
    host: config.jiraBaseUrl.replace(/\/+$/, ""),
    noCheckAtlassianToken: true,
    authentication: credentials.email
      ? { basic: { email: credentials.email, apiToken: credentials.apiToken } }
      : { oauth2: { accessToken: credentials.apiToken } },
  }) as unknown as Version2Client;
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

function buildBatch(
  documents: ConnectorDocument[],
  // biome-ignore lint/suspicious/noExplicitAny: SDK issue types vary between v2/v3
  issues: any[],
  checkpoint: JiraCheckpoint,
  hasMore: boolean,
): ConnectorSyncBatch {
  const lastIssue = issues.length > 0 ? issues[issues.length - 1] : null;
  const rawUpdatedAt: string | undefined = lastIssue?.fields?.updated;

  return {
    documents,
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
function extractJiraErrorDetails(error: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = {};

  if (!(error instanceof Error)) {
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

  // Check cause chain
  if (err.cause && !details.status) {
    Object.assign(details, extractJiraErrorDetails(err.cause));
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
): string {
  const clauses: string[] = [];

  if (config.projectKey) {
    clauses.push(`project = "${config.projectKey}"`);
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

  // Enhanced search requires at least one restriction (bounded query)
  if (clauses.length === 0) {
    clauses.push("project IS NOT EMPTY");
  }

  const jql = clauses.join(" AND ");
  if (!clauses.some((c) => c.includes("ORDER BY"))) {
    return `${jql} ORDER BY updated ASC`;
  }
  return jql;
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
      assignee: fields.assignee?.displayName,
      labels: fields.labels,
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
