import { Gitlab } from "@gitbeaker/rest";
import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  GitlabCheckpoint,
  GitlabConfig,
} from "@/types";
import { GitlabConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const BATCH_SIZE = 50;

export class GitlabConnector extends BaseConnector {
  type = "gitlab" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseGitlabConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error: "Invalid GitLab configuration: gitlabUrl (string) is required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.gitlabUrl)) {
      return {
        valid: false,
        error: "gitlabUrl must be a valid HTTP(S) URL",
      };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseGitlabConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid GitLab configuration" };
    }

    this.log.debug({ baseUrl: parsed.gitlabUrl }, "Testing connection");

    try {
      const client = createGitlabClient(parsed, params.credentials);
      await client.Users.showCurrentUser();
      this.log.debug("Connection test successful");
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error({ error: message }, "Connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseGitlabConfig(params.config);
    if (!parsed) return null;

    // Markdown file count cannot be estimated without fetching the full repo tree,
    // so skip estimation entirely when markdown syncing is enabled.
    if (parsed.includeMarkdownFiles) return null;

    this.log.debug(
      { projectIds: parsed.projectIds, groupId: parsed.groupId },
      "Estimating total items",
    );

    try {
      const client = createGitlabClient(parsed, params.credentials);
      const projects = await getProjects(client, parsed);
      let total = 0;

      for (const project of projects) {
        if (parsed.includeIssues !== false) {
          const result = await client.Issues.all({
            projectId: project.id,
            perPage: 1,
            page: 1,
            showExpanded: true,
          });
          // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker expanded response includes paginationInfo
          const expanded = result as any;
          total += expanded?.paginationInfo?.total ?? 0;
        }

        if (parsed.includeMergeRequests !== false) {
          const result = await client.MergeRequests.all({
            projectId: project.id,
            perPage: 1,
            page: 1,
            showExpanded: true,
          });
          // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker expanded response includes paginationInfo
          const expanded = result as any;
          total += expanded?.paginationInfo?.total ?? 0;
        }
      }

      return total > 0 ? total : null;
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
    const parsed = parseGitlabConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid GitLab configuration");
    }

    const checkpoint = (params.checkpoint as GitlabCheckpoint | null) ?? {
      type: "gitlab" as const,
    };
    const client = createGitlabClient(parsed, params.credentials);
    const projects = await getProjects(client, parsed);

    this.log.debug(
      {
        baseUrl: parsed.gitlabUrl,
        projectCount: projects.length,
        includeIssues: parsed.includeIssues,
        includeMergeRequests: parsed.includeMergeRequests,
        checkpoint,
      },
      "Starting sync",
    );

    for (let projIdx = 0; projIdx < projects.length; projIdx++) {
      const project = projects[projIdx];
      const isLastProject = projIdx === projects.length - 1;
      const hasMarkdown = parsed.includeMarkdownFiles === true;

      if (parsed.includeIssues !== false) {
        yield* this.syncProjectIssues({
          client,
          config: parsed,
          project,
          checkpoint,
          isLastGroup:
            isLastProject &&
            parsed.includeMergeRequests === false &&
            !hasMarkdown,
        });
      }

      if (parsed.includeMergeRequests !== false) {
        yield* this.syncProjectMergeRequests({
          client,
          config: parsed,
          project,
          checkpoint,
          isLastGroup: isLastProject && !hasMarkdown,
        });
      }

      if (hasMarkdown) {
        yield* this.syncProjectMarkdownFiles({
          client,
          project,
          checkpoint,
          isLastGroup: isLastProject,
        });
      }
    }
  }

  // ===== Private methods =====

  private async *syncProjectIssues(params: {
    client: InstanceType<typeof Gitlab>;
    config: GitlabConfig;
    project: GitlabProject;
    checkpoint: GitlabCheckpoint;
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { client, config, project, checkpoint, isLastGroup } = params;
    let page = 1;
    let pageHasMore = true;

    this.log.debug(
      { project: project.pathWithNamespace },
      "Syncing project issues",
    );

    while (pageHasMore) {
      await this.rateLimit();

      try {
        this.log.debug(
          { project: project.pathWithNamespace, page },
          "Fetching issues batch",
        );

        // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
        const issues: any[] = await client.Issues.all({
          projectId: project.id,
          perPage: BATCH_SIZE,
          page,
          sort: "asc",
          orderBy: "updated_at",
          ...(checkpoint.lastSyncedAt
            ? { updatedAfter: checkpoint.lastSyncedAt }
            : {}),
        });

        const filtered = issues.filter(
          (issue: { labels?: string[] }) =>
            !shouldSkipByLabels(issue.labels ?? [], config.labelsToSkip),
        );

        const documents: ConnectorDocument[] = [];
        for (const issue of filtered) {
          await this.rateLimit();
          const notes = await this.safeItemFetch({
            fetch: () => getIssueNotes(client, project.id, issue.iid),
            fallback: [],
            itemId: issue.iid,
            resource: "notes",
          });
          documents.push(issueToDocument(issue, notes, project));
        }

        pageHasMore = issues.length >= BATCH_SIZE;
        page++;

        this.log.debug(
          {
            project: project.pathWithNamespace,
            issueCount: issues.length,
            documentCount: documents.length,
            hasMore: pageHasMore || !isLastGroup,
          },
          "Issues batch fetched",
        );

        const lastIssue =
          filtered.length > 0 ? filtered[filtered.length - 1] : null;
        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "gitlab",
            itemUpdatedAt: lastIssue?.updated_at,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore: pageHasMore || !isLastGroup,
        };
      } catch (error) {
        this.log.error(
          {
            project: project.pathWithNamespace,
            page,
            error: extractErrorMessage(error),
          },
          "Issues batch fetch failed",
        );
        throw error;
      }
    }
  }

  private async *syncProjectMergeRequests(params: {
    client: InstanceType<typeof Gitlab>;
    config: GitlabConfig;
    project: GitlabProject;
    checkpoint: GitlabCheckpoint;
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { client, config, project, checkpoint, isLastGroup } = params;
    let page = 1;
    let pageHasMore = true;

    this.log.debug(
      { project: project.pathWithNamespace },
      "Syncing project merge requests",
    );

    while (pageHasMore) {
      await this.rateLimit();

      try {
        this.log.debug(
          { project: project.pathWithNamespace, page },
          "Fetching merge requests batch",
        );

        // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
        const mergeRequests: any[] = await client.MergeRequests.all({
          projectId: project.id,
          perPage: BATCH_SIZE,
          page,
          sort: "asc",
          orderBy: "updated_at",
          ...(checkpoint.lastSyncedAt
            ? { updatedAfter: checkpoint.lastSyncedAt }
            : {}),
        });

        const filtered = mergeRequests.filter(
          (mr: { labels?: string[] }) =>
            !shouldSkipByLabels(mr.labels ?? [], config.labelsToSkip),
        );

        const documents: ConnectorDocument[] = [];
        for (const mr of filtered) {
          await this.rateLimit();
          const notes = await this.safeItemFetch({
            fetch: () => getMergeRequestNotes(client, project.id, mr.iid),
            fallback: [],
            itemId: mr.iid,
            resource: "notes",
          });
          documents.push(mergeRequestToDocument(mr, notes, project));
        }

        pageHasMore = mergeRequests.length >= BATCH_SIZE;
        page++;

        this.log.debug(
          {
            project: project.pathWithNamespace,
            mrCount: mergeRequests.length,
            documentCount: documents.length,
            hasMore: pageHasMore || !isLastGroup,
          },
          "Merge requests batch fetched",
        );

        const lastMr =
          filtered.length > 0 ? filtered[filtered.length - 1] : null;
        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "gitlab",
            itemUpdatedAt: lastMr?.updated_at,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
          }),
          hasMore: pageHasMore || !isLastGroup,
        };
      } catch (error) {
        this.log.error(
          {
            project: project.pathWithNamespace,
            page,
            error: extractErrorMessage(error),
          },
          "Merge requests batch fetch failed",
        );
        throw error;
      }
    }
  }
  private async *syncProjectMarkdownFiles(params: {
    client: InstanceType<typeof Gitlab>;
    project: GitlabProject;
    checkpoint: GitlabCheckpoint;
    isLastGroup: boolean;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { client, project, checkpoint, isLastGroup } = params;

    this.log.info(
      { project: project.pathWithNamespace },
      "Starting markdown file sync",
    );

    this.log.debug(
      { project: project.pathWithNamespace, ref: "HEAD" },
      "Fetching repository tree",
    );

    // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
    let treeItems: any[];
    try {
      treeItems = (await client.Repositories.allRepositoryTrees(project.id, {
        recursive: true,
        // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
      })) as any[];
    } catch (err) {
      this.log.error(
        {
          project: project.pathWithNamespace,
          ref: "HEAD",
          error: extractErrorMessage(err),
        },
        "Failed to fetch repository tree, skipping markdown sync",
      );
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "gitlab",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    const markdownFiles = treeItems.filter(
      (item) => item.type === "blob" && isMarkdownFile(String(item.path ?? "")),
    );

    this.log.info(
      {
        project: project.pathWithNamespace,
        ref: "HEAD",
        totalTreeItems: treeItems.length,
        markdownFileCount: markdownFiles.length,
      },
      "Found markdown files in project",
    );

    if (markdownFiles.length === 0) {
      yield {
        documents: [],
        failures: this.flushFailures(),
        checkpoint: buildCheckpoint({
          type: "gitlab",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: !isLastGroup,
      };
      return;
    }

    for (let i = 0; i < markdownFiles.length; i += BATCH_SIZE) {
      const batch = markdownFiles.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(markdownFiles.length / BATCH_SIZE);
      const documents: ConnectorDocument[] = [];

      this.log.debug(
        {
          project: project.pathWithNamespace,
          ref: "HEAD",
          batch: batchNumber,
          totalBatches,
          batchSize: batch.length,
        },
        "Fetching markdown file contents",
      );

      for (const file of batch) {
        await this.rateLimit();
        const filePath = String(file.path);
        const content = await this.safeItemFetch({
          fetch: () => getFileContent(client, project.id, filePath),
          fallback: null,
          itemId: filePath,
          resource: "file_content",
        });

        if (content !== null) {
          documents.push(markdownFileToDocument(filePath, content, project));
        }
      }

      const failures = this.flushFailures();
      const hasMoreFiles = i + BATCH_SIZE < markdownFiles.length;

      this.log.info(
        {
          project: project.pathWithNamespace,
          ref: "HEAD",
          batch: batchNumber,
          totalBatches,
          documentsIndexed: documents.length,
          failureCount: failures.length,
          hasMore: hasMoreFiles || !isLastGroup,
        },
        "Markdown file batch completed",
      );

      yield {
        documents,
        failures,
        checkpoint: buildCheckpoint({
          type: "gitlab",
          itemUpdatedAt: null,
          previousLastSyncedAt: checkpoint.lastSyncedAt,
        }),
        hasMore: hasMoreFiles || !isLastGroup,
      };
    }
  }
}

// ===== Module-level helpers =====

interface GitlabProject {
  id: number;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
}

function createGitlabClient(
  config: GitlabConfig,
  credentials: ConnectorCredentials,
): InstanceType<typeof Gitlab> {
  return new Gitlab({
    host: config.gitlabUrl.replace(/\/+$/, ""),
    token: credentials.apiToken,
  });
}

function parseGitlabConfig(
  config: Record<string, unknown>,
): GitlabConfig | null {
  const result = GitlabConfigSchema.safeParse({ type: "gitlab", ...config });
  return result.success ? result.data : null;
}

async function getProjects(
  client: InstanceType<typeof Gitlab>,
  config: GitlabConfig,
): Promise<GitlabProject[]> {
  if (config.projectIds && config.projectIds.length > 0) {
    const projects: GitlabProject[] = [];
    for (const projectId of config.projectIds) {
      // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
      const project: any = await client.Projects.show(projectId);
      projects.push({
        id: project.id,
        name: project.name,
        pathWithNamespace: String(project.path_with_namespace),
        webUrl: String(project.web_url),
      });
    }
    return projects;
  }

  if (config.groupId) {
    const groupProjects = (await client.Groups.allProjects(config.groupId, {
      perPage: 100,
      // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
    })) as any[];
    return groupProjects.map((p) => ({
      id: p.id,
      name: p.name,
      pathWithNamespace: String(p.path_with_namespace),
      webUrl: String(p.web_url),
    }));
  }

  const allProjects = (await client.Projects.all({
    membership: true,
    perPage: 100,
    // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
  })) as any[];
  return allProjects.map((p) => ({
    id: p.id,
    name: p.name,
    pathWithNamespace: String(p.path_with_namespace),
    webUrl: String(p.web_url),
  }));
}

async function getIssueNotes(
  client: InstanceType<typeof Gitlab>,
  projectId: number,
  issueIid: number,
): Promise<Array<{ author: string; body: string; date: string }>> {
  const notes = (await client.IssueNotes.all(projectId, issueIid, {
    perPage: 100,
    // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
  })) as any[];
  return notes
    .filter((n) => !n.system)
    .map((n) => ({
      author: String(n.author?.name ?? n.author?.username ?? "unknown"),
      body: String(n.body ?? ""),
      date: n.created_at
        ? new Date(String(n.created_at)).toISOString().slice(0, 10)
        : "",
    }));
}

async function getMergeRequestNotes(
  client: InstanceType<typeof Gitlab>,
  projectId: number,
  mrIid: number,
): Promise<Array<{ author: string; body: string; date: string }>> {
  const notes = (await client.MergeRequestNotes.all(projectId, mrIid, {
    perPage: 100,
    // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
  })) as any[];
  return notes
    .filter((n) => !n.system)
    .map((n) => ({
      author: String(n.author?.name ?? n.author?.username ?? "unknown"),
      body: String(n.body ?? ""),
      date: n.created_at
        ? new Date(String(n.created_at)).toISOString().slice(0, 10)
        : "",
    }));
}

function shouldSkipByLabels(
  itemLabels: string[],
  labelsToSkip?: string[],
): boolean {
  if (!labelsToSkip || labelsToSkip.length === 0) return false;
  return itemLabels.some((label) => labelsToSkip.includes(label));
}

function isMarkdownFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}

async function getFileContent(
  client: InstanceType<typeof Gitlab>,
  projectId: number,
  filePath: string,
): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: Gitbeaker Camelize types
  const file: any = await client.RepositoryFiles.show(
    projectId,
    filePath,
    "HEAD",
  );
  if (!file.content) {
    throw new Error(`No content returned for ${filePath}`);
  }
  return Buffer.from(String(file.content), "base64").toString("utf-8");
}

function markdownFileToDocument(
  filePath: string,
  content: string,
  project: GitlabProject,
): ConnectorDocument {
  const fileName = filePath.split("/").pop() ?? filePath;
  return {
    id: `${project.pathWithNamespace}#file:${filePath}`,
    title: `${fileName} (${project.pathWithNamespace})`,
    content,
    sourceUrl: `${project.webUrl}/-/blob/HEAD/${filePath}`,
    metadata: {
      project: project.pathWithNamespace,
      filePath,
      kind: "markdown_file",
    },
  };
}

function issueToDocument(
  // biome-ignore lint/suspicious/noExplicitAny: GitLab API response types
  issue: any,
  notes: Array<{ author: string; body: string; date: string }>,
  project: GitlabProject,
): ConnectorDocument {
  const contentParts = [`# Issue: ${issue.title}`, "", issue.description ?? ""];

  const nonEmptyNotes = notes.filter((n) => n.body.trim());
  if (nonEmptyNotes.length > 0) {
    contentParts.push("", "## Comments", "");
    for (const n of nonEmptyNotes) {
      contentParts.push(`**${n.author}** (${n.date}): ${n.body}`);
    }
  }

  return {
    id: `${project.pathWithNamespace}#issue-${issue.iid}`,
    title: `${issue.title} (${project.pathWithNamespace}#${issue.iid})`,
    content: contentParts.join("\n"),
    sourceUrl: issue.web_url,
    metadata: {
      project: project.pathWithNamespace,
      iid: issue.iid,
      state: issue.state,
      kind: "issue",
      labels: issue.labels ?? [],
      author: issue.author?.username,
    },
    updatedAt: issue.updated_at ? new Date(issue.updated_at) : undefined,
  };
}

function mergeRequestToDocument(
  // biome-ignore lint/suspicious/noExplicitAny: GitLab API response types
  mr: any,
  notes: Array<{ author: string; body: string; date: string }>,
  project: GitlabProject,
): ConnectorDocument {
  const contentParts = [
    `# Merge Request: ${mr.title}`,
    "",
    mr.description ?? "",
  ];

  const nonEmptyNotes = notes.filter((n) => n.body.trim());
  if (nonEmptyNotes.length > 0) {
    contentParts.push("", "## Comments", "");
    for (const n of nonEmptyNotes) {
      contentParts.push(`**${n.author}** (${n.date}): ${n.body}`);
    }
  }

  return {
    id: `${project.pathWithNamespace}#mr-${mr.iid}`,
    title: `${mr.title} (${project.pathWithNamespace}!${mr.iid})`,
    content: contentParts.join("\n"),
    sourceUrl: mr.web_url,
    metadata: {
      project: project.pathWithNamespace,
      iid: mr.iid,
      state: mr.state,
      kind: "merge_request",
      labels: mr.labels ?? [],
      author: mr.author?.username,
    },
    updatedAt: mr.updated_at ? new Date(mr.updated_at) : undefined,
  };
}
