import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
} from "@/types/knowledge-connectors/connector";
import type {
  JiraCheckpoint,
  JiraComment,
  JiraConfig,
  JiraIssue,
  JiraSearchResponse,
} from "@/types/knowledge-connectors/jira";
import { BaseConnector } from "../base-connector";

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

    try {
      const apiVersion = parsed.isCloud ? "3" : "2";
      const url = this.joinUrl(
        parsed.jiraBaseUrl,
        `/rest/api/${apiVersion}/myself`,
      );
      const response = await this.fetchWithRetry(url, {
        method: "GET",
        headers: this.buildHeaders(params.credentials),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          success: false,
          error: `Jira API error ${response.status}: ${text}`,
        };
      }

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    const parsed = parseJiraConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Jira configuration");
    }

    const checkpoint = (params.checkpoint as JiraCheckpoint | null) ?? {};
    const jql = this.buildJql(parsed, checkpoint, params.startTime);
    const apiVersion = parsed.isCloud ? "3" : "2";

    let startAt = 0;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();

      const searchResult = await this.searchIssues({
        baseUrl: parsed.jiraBaseUrl,
        apiVersion,
        jql,
        startAt,
        credentials: params.credentials,
        isCloud: parsed.isCloud,
      });

      const documents: ConnectorDocument[] = [];

      for (const issue of searchResult.issues) {
        if (shouldSkipIssue(issue, parsed.labelsToSkip)) {
          continue;
        }

        const doc = this.issueToDocument({
          issue,
          baseUrl: parsed.jiraBaseUrl,
          isCloud: parsed.isCloud,
          commentEmailBlacklist: parsed.commentEmailBlacklist,
        });
        documents.push(doc);
      }

      startAt += searchResult.maxResults;
      hasMore = startAt < searchResult.total;

      const newCheckpoint: JiraCheckpoint = {
        lastSyncedAt: new Date().toISOString(),
        lastIssueKey:
          searchResult.issues.length > 0
            ? searchResult.issues[searchResult.issues.length - 1].key
            : checkpoint.lastIssueKey,
      };

      yield {
        documents,
        checkpoint: newCheckpoint as unknown as Record<string, unknown>,
        hasMore,
      };
    }
  }

  // ===== Private methods =====

  private buildHeaders(
    credentials: ConnectorCredentials,
  ): Record<string, string> {
    return {
      Authorization: this.buildBasicAuthHeader(
        credentials.email,
        credentials.apiToken,
      ),
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private buildJql(
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

    const syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
    if (syncFrom) {
      const jiraDate = formatJiraDate(syncFrom);
      clauses.push(`updated >= "${jiraDate}"`);
    }

    const jql =
      clauses.length > 0 ? clauses.join(" AND ") : "ORDER BY updated ASC";
    if (!clauses.some((c) => c.includes("ORDER BY")) && clauses.length > 0) {
      return `${jql} ORDER BY updated ASC`;
    }
    return jql;
  }

  private async searchIssues(params: {
    baseUrl: string;
    apiVersion: string;
    jql: string;
    startAt: number;
    credentials: ConnectorCredentials;
    isCloud: boolean;
  }): Promise<JiraSearchResponse> {
    const { baseUrl, apiVersion, jql, startAt, credentials, isCloud } = params;
    const headers = this.buildHeaders(credentials);

    let response: Response;

    if (isCloud) {
      const url = this.joinUrl(baseUrl, `/rest/api/${apiVersion}/search`);
      response = await this.fetchWithRetry(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jql,
          fields: SEARCH_FIELDS,
          startAt,
          maxResults: BATCH_SIZE,
        }),
      });
    } else {
      const queryParams = new URLSearchParams({
        jql,
        fields: SEARCH_FIELDS.join(","),
        startAt: String(startAt),
        maxResults: String(BATCH_SIZE),
      });
      const url = this.joinUrl(
        baseUrl,
        `/rest/api/${apiVersion}/search?${queryParams.toString()}`,
      );
      response = await this.fetchWithRetry(url, {
        method: "GET",
        headers,
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira search failed (${response.status}): ${text}`);
    }

    return (await response.json()) as JiraSearchResponse;
  }

  private issueToDocument(params: {
    issue: JiraIssue;
    baseUrl: string;
    isCloud: boolean;
    commentEmailBlacklist?: string[];
  }): ConnectorDocument {
    const { issue, baseUrl, isCloud, commentEmailBlacklist } = params;
    const fields = issue.fields;

    const descriptionText = isCloud
      ? extractTextFromAdf(fields.description)
      : String(fields.description ?? "");

    const comments = (fields.comment?.comments ?? [])
      .filter(
        (c) => !commentEmailBlacklist?.includes(c.author?.emailAddress ?? ""),
      )
      .map((c) => formatComment(c, isCloud))
      .filter(Boolean);

    const contentParts = [`# ${fields.summary}`, "", descriptionText];

    if (comments.length > 0) {
      contentParts.push("", "## Comments", "", ...comments);
    }

    return {
      id: issue.key,
      title: fields.summary,
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
}

// ===== Module-level helpers =====

function parseJiraConfig(config: Record<string, unknown>): JiraConfig | null {
  if (
    typeof config.jiraBaseUrl !== "string" ||
    typeof config.isCloud !== "boolean"
  ) {
    return null;
  }
  return {
    jiraBaseUrl: config.jiraBaseUrl,
    isCloud: config.isCloud,
    projectKey:
      typeof config.projectKey === "string" ? config.projectKey : undefined,
    jqlQuery: typeof config.jqlQuery === "string" ? config.jqlQuery : undefined,
    commentEmailBlacklist: Array.isArray(config.commentEmailBlacklist)
      ? config.commentEmailBlacklist.filter(
          (e): e is string => typeof e === "string",
        )
      : undefined,
    labelsToSkip: Array.isArray(config.labelsToSkip)
      ? config.labelsToSkip.filter((l): l is string => typeof l === "string")
      : undefined,
  };
}

function shouldSkipIssue(issue: JiraIssue, labelsToSkip?: string[]): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  const issueLabels = issue.fields.labels ?? [];
  return issueLabels.some((label) => labelsToSkip.includes(label));
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

function formatComment(comment: JiraComment, isCloud: boolean): string {
  const author = comment.author?.displayName ?? "Unknown";
  const date = comment.created
    ? new Date(comment.created).toISOString().slice(0, 10)
    : "";
  const body = isCloud
    ? extractTextFromAdf(comment.body)
    : String(comment.body ?? "");

  if (!body.trim()) return "";
  return `**${author}** (${date}): ${body}`;
}

/**
 * Extract plain text from Atlassian Document Format (ADF).
 * ADF is a nested JSON structure used by Jira Cloud v3.
 * Recursively walks the tree and extracts text content.
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
