import { Octokit } from "@octokit/rest";
import type pino from "pino";
import { resolveInstallationToken } from "@/integrations/github/app-auth";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  GithubCheckpoint,
  GithubConfig,
} from "@/types";
import { GithubConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
  REQUEST_TIMEOUT_MS,
} from "../base-connector";

const BATCH_SIZE = 50;

export class GithubConnector extends BaseConnector {
  type = "github" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    return this.validateConfigWithSchema({
      config,
      parser: parseGithubConfig,
      label: "GitHub",
      invalidConfigError:
        "Invalid GitHub configuration: githubUrl (string) and owner (string) are required",
      extraChecks: (parsed) => validateGithubConfig(parsed),
    });
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseGithubConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid GitHub configuration" };
    }

    return this.runConnectionTest({
      label: "GitHub",
      probe: async () => {
        const octokit = await createOctokit(
          parsed,
          params.credentials,
          this.log,
        );
        if (parsed.authMethod === "github_app") {
          await octokit.rest.apps.listReposAccessibleToInstallation({
            per_page: 1,
          });
          return;
        }
        await octokit.rest.users.getAuthenticated();
      },
    });
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseGithubConfig(params.config);
    if (!parsed) return null;

    // Repository file count cannot be estimated without fetching the full repo
    // tree, so skip estimation entirely when file syncing is enabled.
    if (parsed.includeRepositoryFiles) return null;

    this.log.debug(
      { owner: parsed.owner, repos: parsed.repos },
      "Estimating total items",
    );

    try {
      const octokit = await createOctokit(parsed, params.credentials, this.log);
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
    const parsed = parseGithubConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid GitHub configuration");
    }

    const checkpoint = (params.checkpoint as GithubCheckpoint | null) ?? {
      type: "github" as const,
    };
    const octokit = await createOctokit(parsed, params.credentials, this.log);
    const repos = await getRepos(octokit, parsed);

    this.log.debug(
      {
        baseUrl: parsed.githubUrl,
        owner: parsed.owner,
        repoCount: repos.length,
        includeIssues: parsed.includeIssues,
        includePullRequests: parsed.includePullRequests,
        checkpoint,
      },
      "Starting sync",
    );

    for (let repoIdx = 0; repoIdx < repos.length; repoIdx++) {
      const repo = repos[repoIdx];
      const isLastRepo = repoIdx === repos.length - 1;
      const hasRepositoryFiles = parsed.includeRepositoryFiles === true;

      if (parsed.includeIssues !== false) {
        yield* this.syncRepoItems({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          kind: "issue",
          isLastGroup:
            isLastRepo &&
            parsed.includePullRequests === false &&
            !hasRepositoryFiles,
        });
      }

      if (parsed.includePullRequests !== false) {
        yield* this.syncRepoItems({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          kind: "pr",
          isLastGroup: isLastRepo && !hasRepositoryFiles,
        });
      }

      if (hasRepositoryFiles) {
        yield* this.syncRepoFiles({
          octokit,
          config: parsed,
          repo,
          checkpoint,
          isLastGroup: isLastRepo,
        });
      }
    }
  }

  // ===== Private methods =====

  private async *syncRepoItems(params: {
    octokit: Octokit;
    config: GithubConfig;
    repo: GithubRepo;
    checkpoint: GithubCheckpoint;
    kind: "issue" | "pr";
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { octokit, config, repo, checkpoint, kind, isLastGroup } = params;
    let page = 1;
    let pageHasMore = true;

    this.log.debug(
      { repo: `${repo.owner}/${repo.name}`, kind },
      "Syncing repo items",
    );

    while (pageHasMore) {
      await this.rateLimit();

      let response: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>;
      try {
        this.log.debug(
          { repo: `${repo.owner}/${repo.name}`, kind, page },
          "Fetching batch",
        );

        response = await octokit.rest.issues.listForRepo({
          owner: repo.owner,
          repo: repo.name,
          state: "all",
          per_page: BATCH_SIZE,
          page,
          sort: "updated",
          direction: "asc",
          ...(checkpoint.lastSyncedAt
            ? { since: checkpoint.lastSyncedAt }
            : {}),
        });
      } catch (err) {
        if (
          err instanceof Error &&
          "status" in err &&
          (err as Record<string, unknown>).status === 404
        ) {
          this.log.debug(
            { repo: `${repo.owner}/${repo.name}`, kind },
            "Repo not found or issues disabled, skipping",
          );
          break;
        }
        this.log.error(
          {
            repo: `${repo.owner}/${repo.name}`,
            kind,
            page,
            error: extractErrorMessage(err),
          },
          "Batch fetch failed",
        );
        throw err;
      }

      const items = response.data.filter((item) => {
        const isPr = !!item.pull_request;
        if (kind === "issue" && isPr) return false;
        if (kind === "pr" && !isPr) return false;
        return !shouldSkipItem(item, config.labelsToSkip);
      });

      const documents: ConnectorDocument[] = [];
      for (const item of items) {
        await this.rateLimit();
        const comments = await this.safeItemFetch({
          fetch: () => getItemComments(octokit, repo, item.number),
          fallback: [],
          itemId: item.number,
          resource: "comments",
        });
        documents.push(itemToDocument(item, comments, repo, kind));
      }

      pageHasMore = response.data.length >= BATCH_SIZE;
      page++;

      this.log.debug(
        {
          repo: `${repo.owner}/${repo.name}`,
          kind,
          itemCount: items.length,
          documentCount: documents.length,
          hasMore: pageHasMore || !isLastGroup,
        },
        "Batch fetched",
      );

      const lastItem = items.length > 0 ? items[items.length - 1] : null;

      yield {
        documents,
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: lastItem?.updated_at,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: pageHasMore || !isLastGroup,
      };
    }
  }
  private async *syncRepoFiles(params: {
    octokit: Octokit;
    config: GithubConfig;
    repo: GithubRepo;
    checkpoint: GithubCheckpoint;
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { octokit, config, repo, checkpoint, isLastGroup } = params;
    const repoFullName = `${repo.owner}/${repo.name}`;
    const indexedExtensions = getIndexedFileExtensions(config);

    this.log.info(
      { repo: repoFullName, indexedExtensions },
      "Starting repository file sync",
    );

    let treeSha: string;
    let branch: string;

    const branchCandidates = repo.defaultBranch
      ? [repo.defaultBranch]
      : FALLBACK_BRANCHES;

    const resolved = await resolveDefaultBranch(
      octokit,
      repo,
      branchCandidates,
      this.log,
    );

    if (!resolved) {
      this.log.error(
        { repo: repoFullName, triedBranches: branchCandidates },
        "Could not resolve default branch, skipping markdown sync",
      );
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    branch = resolved.branch;
    treeSha = resolved.sha;

    this.log.debug(
      { repo: repoFullName, branch, treeSha },
      "Fetching repository tree",
    );

    let treeItems: Array<{ path: string; sha: string }>;
    try {
      const treeResponse = await octokit.rest.git.getTree({
        owner: repo.owner,
        repo: repo.name,
        tree_sha: treeSha,
        recursive: "true",
      });
      const allItems = treeResponse.data.tree;
      treeItems = allItems
        .filter(
          (item) =>
            item.type === "blob" &&
            item.path &&
            isIndexedRepositoryFile(item.path, indexedExtensions) &&
            item.sha,
        )
        .map((item) => ({
          path: item.path as string,
          sha: item.sha as string,
        }));

      this.log.info(
        {
          repo: repoFullName,
          branch,
          totalTreeItems: allItems.length,
          fileCount: treeItems.length,
        },
        "Found repository files to index",
      );
    } catch (err) {
      this.log.error(
        {
          repo: repoFullName,
          branch,
          treeSha,
          error: extractErrorMessage(err),
        },
        "Failed to fetch repository tree, skipping file sync",
      );
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    if (treeItems.length === 0) {
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    for (let i = 0; i < treeItems.length; i += BATCH_SIZE) {
      const batch = treeItems.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(treeItems.length / BATCH_SIZE);
      const documents: ConnectorDocument[] = [];

      this.log.debug(
        {
          repo: repoFullName,
          branch,
          batch: batchNumber,
          totalBatches,
          batchSize: batch.length,
        },
        "Fetching repository file contents",
      );

      for (const file of batch) {
        await this.rateLimit();
        const content = await this.safeItemFetch({
          fetch: () => getFileContent(octokit, repo, file.path),
          fallback: null,
          itemId: file.path,
          resource: "file_content",
        });

        if (content !== null) {
          documents.push(
            repositoryFileToDocument(file.path, content, repo, branch),
          );
        }
      }

      const failures = this.flushFailures();
      const hasMoreFiles = i + BATCH_SIZE < treeItems.length;

      this.log.info(
        {
          repo: repoFullName,
          branch,
          batch: batchNumber,
          totalBatches,
          documentsIndexed: documents.length,
          failureCount: failures.length,
          hasMore: hasMoreFiles || !isLastGroup,
        },
        "Repository file batch completed",
      );

      yield {
        documents,
        failures,
        checkpoint: buildCheckpoint({
          type: "github",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: hasMoreFiles || !isLastGroup,
      };
    }
  }
}

// ===== Module-level helpers =====

async function createOctokit(
  config: GithubConfig,
  credentials: ConnectorCredentials,
  log: pino.Logger,
): Promise<Octokit> {
  const nativeFetch = globalThis.fetch;
  const auth = await resolveGithubAuthToken(config, credentials, nativeFetch);
  return new Octokit({
    auth,
    baseUrl: resolveGithubApiUrl(config, credentials).replace(/\/+$/, ""),
    log: {
      debug: (message: string) =>
        log.debug({ sdkMessage: message }, "SDK debug"),
      info: (message: string) => log.debug({ sdkMessage: message }, "SDK info"),
      warn: (message: string) =>
        log.warn({ sdkMessage: message }, "SDK warning"),
      error: (message: string) =>
        log.error({ sdkMessage: message }, "SDK error"),
    },
    request: {
      fetch: (url: string | URL | Request, init?: RequestInit) =>
        nativeFetch(url, {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
    },
  });
}

// the App config owns the host its installation token is minted against, so
// App-auth connectors must talk to that host regardless of config.githubUrl
function resolveGithubApiUrl(
  config: GithubConfig,
  credentials: ConnectorCredentials,
): string {
  if (config.authMethod === "github_app" && credentials.githubApp) {
    return credentials.githubApp.githubUrl;
  }
  return config.githubUrl;
}

async function resolveGithubAuthToken(
  config: GithubConfig,
  credentials: ConnectorCredentials,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (config.authMethod !== "github_app") {
    return credentials.apiToken;
  }

  const app = credentials.githubApp;
  if (!app) {
    throw new Error(
      "GitHub App credentials were not resolved for this connector",
    );
  }

  return resolveInstallationToken(
    {
      githubUrl: app.githubUrl,
      appId: app.appId,
      installationId: app.installationId,
      privateKey: credentials.apiToken,
    },
    fetchImpl,
  );
}

function parseGithubConfig(
  config: Record<string, unknown>,
): GithubConfig | null {
  const result = GithubConfigSchema.safeParse({ type: "github", ...config });
  return result.success ? result.data : null;
}

function validateGithubConfig(config: GithubConfig): string | null {
  if (!/^https?:\/\/.+/.test(config.githubUrl)) {
    return "githubUrl must be a valid HTTP(S) URL";
  }

  if (config.authMethod === "github_app" && !config.githubAppConfigId) {
    return "GitHub App authentication requires githubAppConfigId";
  }

  return null;
}

type GithubRepo = {
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string | null;
};

async function getRepos(
  octokit: Octokit,
  config: GithubConfig,
): Promise<GithubRepo[]> {
  if (config.repos && config.repos.length > 0) {
    const repos: GithubRepo[] = [];
    for (const name of config.repos) {
      let defaultBranch: string | null = null;
      try {
        const response = await octokit.rest.repos.get({
          owner: config.owner,
          repo: name,
        });
        defaultBranch = response.data.default_branch;
      } catch {
        // If we can't fetch repo metadata, fall back to null (main→master fallback)
      }
      repos.push({
        owner: config.owner,
        name,
        htmlUrl: `${config.githubUrl.replace(/\/api\/v3$/, "").replace(/\/+$/, "")}/${config.owner}/${name}`,
        defaultBranch,
      });
    }
    return repos;
  }

  const repos: GithubRepo[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    if (config.authMethod === "github_app") {
      const response =
        await octokit.rest.apps.listReposAccessibleToInstallation({
          per_page: 100,
          page,
        });

      for (const repo of response.data.repositories) {
        repos.push({
          owner: repo.owner?.login ?? config.owner,
          name: repo.name,
          htmlUrl: repo.html_url,
          defaultBranch: repo.default_branch ?? null,
        });
      }

      hasMore = response.data.repositories.length >= 100;
    } else {
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
          defaultBranch: repo.default_branch ?? null,
        });
      }

      hasMore = response.data.length >= 100;
    }

    page++;
  }

  return repos;
}

const FALLBACK_BRANCHES = ["main", "master", "dev", "develop"];

async function resolveDefaultBranch(
  octokit: Octokit,
  repo: { owner: string; name: string },
  candidates: string[],
  log: pino.Logger,
): Promise<{ branch: string; sha: string } | null> {
  const repoFullName = `${repo.owner}/${repo.name}`;
  for (const candidate of candidates) {
    try {
      log.debug(
        { repo: repoFullName, branch: candidate },
        "Resolving branch ref",
      );
      const refResponse = await octokit.rest.git.getRef({
        owner: repo.owner,
        repo: repo.name,
        ref: `heads/${candidate}`,
      });
      log.debug(
        {
          repo: repoFullName,
          branch: candidate,
          sha: refResponse.data.object.sha,
        },
        "Resolved branch ref",
      );
      return { branch: candidate, sha: refResponse.data.object.sha };
    } catch (err) {
      log.info(
        {
          repo: repoFullName,
          branch: candidate,
          error: extractErrorMessage(err),
        },
        "Branch not found, trying next candidate",
      );
    }
  }
  return null;
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

const DEFAULT_REPOSITORY_FILE_EXTENSIONS = [".md", ".mdx", ".yaml", ".yml"];

function getIndexedFileExtensions(config: GithubConfig): string[] {
  const extensions =
    config.fileTypes && config.fileTypes.length > 0
      ? config.fileTypes
      : DEFAULT_REPOSITORY_FILE_EXTENSIONS;

  return extensions
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
    .map((extension) =>
      extension.startsWith(".") ? extension : `.${extension}`,
    );
}

function isIndexedRepositoryFile(path: string, extensions: string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

async function getFileContent(
  octokit: Octokit,
  repo: { owner: string; name: string },
  path: string,
): Promise<string> {
  const response = await octokit.rest.repos.getContent({
    owner: repo.owner,
    repo: repo.name,
    path,
  });

  const data = response.data;
  if (!("content" in data) || !data.content) {
    throw new Error(`No content returned for ${path}`);
  }

  return Buffer.from(data.content, "base64").toString("utf-8");
}

function repositoryFileToDocument(
  filePath: string,
  content: string,
  repo: { owner: string; name: string; htmlUrl: string },
  branch: string,
): ConnectorDocument {
  const fileName = filePath.split("/").pop() ?? filePath;
  return {
    id: `${repo.name}#file:${filePath}`,
    title: `${fileName} (${repo.owner}/${repo.name})`,
    content,
    sourceUrl: `${repo.htmlUrl}/blob/${branch}/${filePath}`,
    metadata: {
      repo: `${repo.owner}/${repo.name}`,
      filePath,
      kind: "repository_file",
      fileKind: "repository_file",
    },
  };
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
