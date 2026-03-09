import { Octokit } from "@octokit/rest";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  GithubCheckpoint,
  GithubConfig,
} from "@/types/knowledge-connector";
import { GithubConfigSchema } from "@/types/knowledge-connector";
import { BaseConnector, buildCheckpoint } from "../base-connector";

const BATCH_SIZE = 50;

export class GithubConnector extends BaseConnector {
  type = "github" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseGithubConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid GitHub configuration: githubUrl (string) and owner (string) are required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.githubUrl)) {
      return {
        valid: false,
        error: "githubUrl must be a valid HTTP(S) URL",
      };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseGithubConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid GitHub configuration" };
    }

    try {
      const octokit = createOctokit(parsed, params.credentials);
      await octokit.rest.users.getAuthenticated();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseGithubConfig(params.config);
    if (!parsed) return null;

    try {
      const octokit = createOctokit(parsed, params.credentials);
      const repos = await getRepos(octokit, parsed);
      let total = 0;

      for (const repo of repos) {
        if (parsed.includeIssues !== false) {
          const result = await octokit.rest.search.issuesAndPullRequests({
            q: `repo:${repo.owner}/${repo.name} is:issue`,
            per_page: 1,
          });
          total += result.data.total_count;
        }

        if (parsed.includePullRequests !== false) {
          const result = await octokit.rest.search.issuesAndPullRequests({
            q: `repo:${repo.owner}/${repo.name} is:pr`,
            per_page: 1,
          });
          total += result.data.total_count;
        }

        await this.rateLimit();
      }

      return total;
    } catch {
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
    const parsed = parseGithubConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid GitHub configuration");
    }

    const checkpoint = (params.checkpoint as GithubCheckpoint | null) ?? {
      type: "github" as const,
    };
    const octokit = createOctokit(parsed, params.credentials);
    const repos = await getRepos(octokit, parsed);

    for (let repoIdx = 0; repoIdx < repos.length; repoIdx++) {
      const repo = repos[repoIdx];
      const isLastRepo = repoIdx === repos.length - 1;

      if (parsed.includeIssues !== false) {
        yield* this.syncRepoItems({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          kind: "issue",
          isLastGroup: isLastRepo && parsed.includePullRequests === false,
        });
      }

      if (parsed.includePullRequests !== false) {
        yield* this.syncRepoItems({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          kind: "pr",
          isLastGroup: isLastRepo,
        });
      }
    }
  }

  // ===== Private methods =====

  private async *syncRepoItems(params: {
    octokit: Octokit;
    config: GithubConfig;
    repo: { owner: string; name: string; htmlUrl: string };
    checkpoint: GithubCheckpoint;
    kind: "issue" | "pr";
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { octokit, config, repo, checkpoint, kind, isLastGroup } = params;
    let page = 1;
    let pageHasMore = true;

    while (pageHasMore) {
      await this.rateLimit();

      const response = await octokit.rest.issues.listForRepo({
        owner: repo.owner,
        repo: repo.name,
        state: "all",
        per_page: BATCH_SIZE,
        page,
        sort: "updated",
        direction: "asc",
        ...(checkpoint.lastSyncedAt ? { since: checkpoint.lastSyncedAt } : {}),
      });

      const items = response.data.filter((item) => {
        const isPr = !!item.pull_request;
        if (kind === "issue" && isPr) return false;
        if (kind === "pr" && !isPr) return false;
        return !shouldSkipItem(item, config.labelsToSkip);
      });

      const documents: ConnectorDocument[] = [];
      for (const item of items) {
        await this.rateLimit();
        const comments = await getItemComments(octokit, repo, item.number);
        documents.push(itemToDocument(item, comments, repo, kind));
      }

      pageHasMore = response.data.length >= BATCH_SIZE;
      page++;

      const lastItem = items.length > 0 ? items[items.length - 1] : null;

      yield {
        documents,
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: lastItem?.updated_at,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: pageHasMore || !isLastGroup,
      };
    }
  }
}

// ===== Module-level helpers =====

function createOctokit(
  config: GithubConfig,
  credentials: ConnectorCredentials,
): Octokit {
  return new Octokit({
    auth: credentials.apiToken,
    baseUrl: config.githubUrl.replace(/\/+$/, ""),
  });
}

function parseGithubConfig(
  config: Record<string, unknown>,
): GithubConfig | null {
  const result = GithubConfigSchema.safeParse({ type: "github", ...config });
  return result.success ? result.data : null;
}

async function getRepos(
  octokit: Octokit,
  config: GithubConfig,
): Promise<Array<{ owner: string; name: string; htmlUrl: string }>> {
  if (config.repos && config.repos.length > 0) {
    return config.repos.map((name) => ({
      owner: config.owner,
      name,
      htmlUrl: `${config.githubUrl.replace(/\/api\/v3$/, "").replace(/\/+$/, "")}/${config.owner}/${name}`,
    }));
  }

  const repos: Array<{ owner: string; name: string; htmlUrl: string }> = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await octokit.rest.repos.listForOrg({
      org: config.owner,
      per_page: 100,
      page,
      type: "all",
    });

    for (const repo of response.data) {
      repos.push({
        owner: config.owner,
        name: repo.name,
        htmlUrl: repo.html_url,
      });
    }

    hasMore = response.data.length >= 100;
    page++;
  }

  return repos;
}

async function getItemComments(
  octokit: Octokit,
  repo: { owner: string; name: string },
  issueNumber: number,
): Promise<Array<{ author: string; body: string; date: string }>> {
  const response = await octokit.rest.issues.listComments({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    per_page: 100,
  });

  return response.data.map((c) => ({
    author: c.user?.login ?? "unknown",
    body: c.body ?? "",
    date: c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : "",
  }));
}

// biome-ignore lint/suspicious/noExplicitAny: GitHub API response types
function shouldSkipItem(item: any, labelsToSkip?: string[]): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  const itemLabels: string[] = (item.labels ?? []).map(
    // biome-ignore lint/suspicious/noExplicitAny: GitHub label shape
    (l: any) => (typeof l === "string" ? l : (l.name ?? "")),
  );
  return itemLabels.some((label) => labelsToSkip.includes(label));
}

function itemToDocument(
  // biome-ignore lint/suspicious/noExplicitAny: GitHub API response types
  item: any,
  comments: Array<{ author: string; body: string; date: string }>,
  repo: { owner: string; name: string; htmlUrl: string },
  kind: "issue" | "pr",
): ConnectorDocument {
  const prefix = kind === "pr" ? "Pull Request" : "Issue";
  const contentParts = [`# ${prefix}: ${item.title}`, "", item.body ?? ""];

  const nonEmptyComments = comments.filter((c) => c.body.trim());
  if (nonEmptyComments.length > 0) {
    contentParts.push("", "## Comments", "");
    for (const c of nonEmptyComments) {
      contentParts.push(`**${c.author}** (${c.date}): ${c.body}`);
    }
  }

  return {
    id: `${repo.name}#${item.number}`,
    title: `${item.title} (${repo.owner}/${repo.name}#${item.number})`,
    content: contentParts.join("\n"),
    sourceUrl: item.html_url,
    metadata: {
      repo: `${repo.owner}/${repo.name}`,
      number: item.number,
      state: item.state,
      kind,
      labels: (item.labels ?? []).map(
        // biome-ignore lint/suspicious/noExplicitAny: GitHub label shape
        (l: any) => (typeof l === "string" ? l : (l.name ?? "")),
      ),
      author: item.user?.login,
    },
    updatedAt: item.updated_at ? new Date(item.updated_at) : undefined,
  };
}
