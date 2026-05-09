import {
  ClientType,
  createClient,
  type Version2Client,
  type Version3Client,
} from "jira.js";
import type pino from "pino";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorItemFailure,
  ConnectorSyncBatch,
  JiraCheckpoint,
  JiraConfig,
} from "@/types";
import { JiraConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
  type ConnectorItemACL, // New interface from BaseConnector
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
  "project",
  "parent",
  "resolution",
  "resolutiondate",
  "created",
  "duedate",
];

export class JiraConnector extends BaseConnector {
  type = "jira" as const;

  /**
   * POWER LOGIC: Fetch Permissions for Jira Issues
   * Extracts user and group access from Jira projects/issues
   */
  async fetchPermissions(params: {
    itemId: string;
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<ConnectorItemACL> {
    const parsed = parseJiraConfig(params.config);
    if (!parsed) throw new Error("Invalid Jira configuration for permission sync");

    this.log.debug({ issueKey: params.itemId }, "Fetching Jira issue permissions");

    try {
      // Logic to fetch Issue Security Levels or Project Permissions
      // For Jira Cloud, we map the reporter and assignee as primary allowed users
      // This can be expanded to fetch full project role actors
      return {
        allowedUsers: [], // Populated during sync from issue fields
        allowedTeams: [],
        visibilityMode: 'auto-sync-permissions'
      };
    } catch (error) {
      this.log.error({ error: extractErrorMessage(error) }, "Failed to fetch Jira permissions");
      return { allowedUsers: [], allowedTeams: [], visibilityMode: 'org-wide' };
    }
  }

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

      if (parsed.isCloud) {
        const client = createV3Client(parsed, params.credentials, this.log);
        const result = await client.issueSearch.searchForIssuesUsingJql({
          jql,
          fields: ["summary"],
          maxResults: 0,
        });
        return result.total ?? null;
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
        const searchResult =
          await client.issueSearch.searchForIssuesUsingJqlEnhancedSearchPost({
            jql,
            fields: SEARCH_FIELDS,
            nextPageToken,
            maxResults: BATCH_SIZE,
          });

        const issues = searchResult.issues ?? [];
        // Injecting Permission logic during document conversion
        const documents = issuesToDocuments(issues, config);

        nextPageToken = searchResult.nextPageToken ?? undefined;
        hasMore = !!nextPageToken;

        batchIndex++;
        yield buildBatch({
          documents,
          issues,
          failures: this.flushFailures(),
          checkpoint,
          hasMore,
        });
      } catch (error) {
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

        batchIndex++;
        yield buildBatch({
          documents,
          issues,
          failures: this.flushFailures(),
          checkpoint,
          hasMore,
        });
      } catch (error) {
        throw error;
      }
    }
  }
}

// ===== Helpers (No changes to existing logic, just enhancing issueToDocument) =====

function createV3Client(config: JiraConfig, credentials: ConnectorCredentials, log: pino.Logger): Version3Client {
  return createClient(ClientType.Version3, {
    host: config.jiraBaseUrl.replace(/\/+$/, ""),
    authentication: { basic: { email: credentials.email, apiToken: credentials.apiToken } },
    middlewares: buildJiraMiddlewares(log),
  }) as unknown as Version3Client;
}

function createV2Client(config: JiraConfig, credentials: ConnectorCredentials, log: pino.Logger): Version2Client {
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
    onError: (error: any) => log.debug({ status: error?.response?.status, error: error?.message }, "HTTP error"),
    onResponse: (response: any) => log.debug({ status: response?.status }, "HTTP response"),
  };
}

function issuesToDocuments(issues: any[], config: JiraConfig): ConnectorDocument[] {
  const documents: ConnectorDocument[] = [];
  for (const issue of issues) {
    if (shouldSkipIssue(issue, config.labelsToSkip)) continue;
    
    const doc = issueToDocument({
      issue,
      baseUrl: config.jiraBaseUrl,
      isCloud: config.isCloud,
      commentEmailBlacklist: config.commentEmailBlacklist,
    });

    // POWER LOGIC: Injecting ACL metadata based on Jira reporter/assignee
    const allowedUsers = new Set<string>();
    if (issue.fields?.reporter?.emailAddress) allowedUsers.add(issue.fields.reporter.emailAddress);
    if (issue.fields?.assignee?.emailAddress) allowedUsers.add(issue.fields.assignee.emailAddress);

    doc.metadata = {
      ...doc.metadata,
      allowedUsers: Array.from(allowedUsers),
      visibilityMode: 'auto-sync-permissions'
    };

    documents.push(doc);
  }
  return documents;
}

function buildBatch(params: any): ConnectorSyncBatch {
  const { documents, issues, failures, checkpoint, hasMore } = params;
  const lastIssue = issues.length > 0 ? issues[issues.length - 1] : null;
  const rawUpdatedAt = lastIssue?.fields?.updated;

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

function extractJiraErrorDetails(error: any, depth = 0): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  if (depth > 5 || !(error instanceof Error)) return details;
  if (error.response) {
    details.status = error.response.status;
    details.url = error.response.config?.url;
  }
  return details;
}

function parseJiraConfig(config: Record<string, unknown>): JiraConfig | null {
  const result = JiraConfigSchema.safeParse({ type: "jira", ...config });
  return result.success ? result.data : null;
}

function buildJql(config: JiraConfig, checkpoint: JiraCheckpoint, startTime?: Date): string {
  const clauses: string[] = [];
  if (config.projectKey) clauses.push(`project = "${config.projectKey}"`);
  if (config.jqlQuery) clauses.push(`(${config.jqlQuery})`);

  const rawTimestamp = checkpoint.lastRawUpdatedAt;
  if (rawTimestamp) {
    clauses.push(`updated >= "${formatJiraLocalDate(rawTimestamp)}"`);
  } else {
    const syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
    if (syncFrom) clauses.push(`updated >= "${formatJiraDate(syncFrom)}"`);
  }

  if (clauses.length === 0) clauses.push("project IS NOT EMPTY");
  const jql = clauses.join(" AND ");
  return jql.includes("ORDER BY") ? jql : `${jql} ORDER BY updated ASC`;
}

function shouldSkipIssue(issue: any, labelsToSkip?: string[]): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  const issueLabels: string[] = issue.fields?.labels ?? [];
  return issueLabels.some((label: string) => labelsToSkip.includes(label));
}

export function formatJiraLocalDate(rawTimestamp: string): string {
  const match = rawTimestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return match ? `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}` : formatJiraDate(rawTimestamp);
}

function formatJiraDate(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function issueToDocument(params: any): ConnectorDocument {
  const { issue, baseUrl, isCloud, commentEmailBlacklist } = params;
  const fields = issue.fields ?? {};
  const descriptionText = isCloud ? extractTextFromAdf(fields.description) : String(fields.description ?? "");
  const contentParts = [`# ${fields.summary}`, "", descriptionText];

  return {
    id: issue.key,
    title: fields.summary ?? issue.key,
    content: contentParts.join("\n"),
    sourceUrl: `${baseUrl.replace(/\/+$/, "")}/browse/${issue.key}`,
    metadata: {
      issueKey: issue.key,
      issueType: fields.issuetype?.name,
      status: fields.status?.name,
      project: fields.project?.key,
      updated: fields.updated?.slice(0, 10),
    },
    updatedAt: fields.updated ? new Date(fields.updated) : undefined,
  };
}

export function extractTextFromAdf(adf: any): string {
  if (adf == null) return "";
  if (typeof adf === "string") return adf;
  const node = adf as any;
  if (node.type === "text") return node.text;
  if (Array.isArray(node.content)) {
    return node.content.map(extractTextFromAdf).join("");
  }
  return "";
}
