import type {
  ConnectorCredentials,
  ConnectorDocument,
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

    const checkpoint = (params.checkpoint as LinearCheckpoint | null) ?? {
      type: "linear" as const,
    };

    let cursor: string | null = null;
    let hasMore = true;

    const url = this.joinUrl(parsed.linearApiUrl, "/graphql");
    const batchSize = parsed.batchSize ?? 50;

    const query = `
      query SyncIssues($first: Int!, $after: String, $filter: IssueFilter) {
        issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            description
            url
            updatedAt
            state { name }
            team { key name }
            project { name }
            labels { nodes { name } }
            comments {
              nodes {
                body
                createdAt
                user { name }
              }
            }
          }
        }
      }
    `;

    while (hasMore) {
      await this.rateLimit();

      const filter: Record<string, unknown> = {};

      if (checkpoint.lastRawUpdatedAt) {
        filter.updatedAt = { gt: checkpoint.lastRawUpdatedAt };
      }

      const variables = {
        first: batchSize,
        after: cursor,
        filter,
      };

      this.log.debug({ cursor }, "Fetching Linear issues batch");

      const response = await this.fetchWithRetry(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.credentials.apiToken}`,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Linear API error: HTTP ${response.status} - ${body.slice(0, 200)}`,
        );
      }

      // biome-ignore lint/suspicious/noExplicitAny: Linear GraphQL response
      const payload = (await response.json()) as any;
      if (payload.errors && payload.errors.length > 0) {
        throw new Error(
          `GraphQL error: ${payload.errors[0]?.message ?? "Unknown"}`,
        );
      }

      const issues = payload.data?.issues?.nodes ?? [];
      const pageInfo = payload.data?.issues?.pageInfo ?? { hasNextPage: false };

      const documents: ConnectorDocument[] = [];
      for (const issue of issues) {
        const metadata: Record<string, unknown> = {
          kind: "issue",
          state: issue.state?.name,
          team: issue.team?.name,
          project: issue.project?.name,
          // biome-ignore lint/suspicious/noExplicitAny: Linear GraphQL response
          labels: issue.labels?.nodes?.map((l: any) => l.name) ?? [],
        };

        const contentParts = [`# ${issue.title}`, "", issue.description ?? ""];

        if (parsed.includeComments !== false && issue.comments?.nodes?.length) {
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

        documents.push({
          id: issue.id,
          title: issue.title,
          content: contentParts.join("\n"),
          sourceUrl: issue.url,
          metadata,
          updatedAt: issue.updatedAt ? new Date(issue.updatedAt) : undefined,
        });
      }

      hasMore = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;

      const lastIssue = issues.length > 0 ? issues[issues.length - 1] : null;

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "linear",
          itemUpdatedAt: lastIssue?.updatedAt,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
          extra: {
            lastRawUpdatedAt:
              lastIssue?.updatedAt ?? checkpoint.lastRawUpdatedAt,
          },
        }),
        hasMore,
      };
    }
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
