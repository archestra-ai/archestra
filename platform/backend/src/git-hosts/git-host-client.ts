import { createHash, randomBytes } from "node:crypto";
import { type GitHost, isCloudGitHost, TimeInMs } from "@archestra/shared";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";

/** A file or folder in a repository tree. */
export interface GitTreeEntry {
  path: string;
  type: "blob" | "tree";
  /** Bytes, when the host reports it (GitHub does, GitLab does not). */
  size?: number;
}

/** A repository the credential can reach. */
export interface GitRepositorySummary {
  path: string;
  private: boolean;
  defaultBranch: string | null;
}

/** An HTTP failure from the host; `status` is 0 when the request never landed. */
export class GitHostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHostError";
  }
}

/**
 * Read-only access to one repository host, GitHub (any host) or GitLab (any
 * host), with an optional token. Every request is bounded and cancellable.
 */
export class GitHostClient {
  constructor(
    readonly host: GitHost,
    private readonly token?: string,
  ) {}

  /** The commit a branch, tag, or SHA points at; null `ref` means the default branch. */
  async resolveCommit(repo: string, ref: string | null): Promise<string> {
    if (this.host.provider === "github") {
      const sha = await this.text(
        `${this.repoApi(repo)}/commits/${encodeURIComponent(ref ?? "HEAD")}`,
        { accept: "application/vnd.github.sha" },
      );
      return sha.trim();
    }
    const target = ref ?? (await this.defaultBranch(repo));
    const commit = await this.json<{ id: string }>(
      `${this.repoApi(repo)}/repository/commits/${encodeURIComponent(target)}`,
    );
    return commit.id;
  }

  async defaultBranch(repo: string): Promise<string> {
    const project = await this.json<{ default_branch?: string | null }>(
      this.repoApi(repo),
    );
    if (!project.default_branch)
      throw new GitHostError(409, `${repo} has no commits yet`);
    return project.default_branch;
  }

  /** Every file and folder at a commit, cached because commits never change. */
  async listTree(repo: string, commitSha: string): Promise<GitTreeEntry[]> {
    const key = cacheKey([this.host.apiUrl, repo, commitSha, this.token]);
    const cached = treeCache.get(key);
    if (cached) return cached;
    const tree =
      this.host.provider === "github"
        ? await this.listGithubTree(repo, commitSha)
        : await this.listGitlabTree(repo, commitSha);
    treeCache.set(key, tree);
    return tree;
  }

  /** A file's bytes at a ref, or null when it does not exist or exceeds `maxBytes`. */
  async readFile(params: {
    repo: string;
    ref: string;
    path: string;
    maxBytes: number;
  }): Promise<Buffer | null> {
    const encodedPath = params.path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const url =
      this.host.provider === "gitlab"
        ? `${this.repoApi(params.repo)}/repository/files/${encodeURIComponent(params.path)}/raw?ref=${encodeURIComponent(params.ref)}`
        : isCloudGitHost(this.host)
          ? // Not counted against the REST rate limit.
            `https://raw.githubusercontent.com/${params.repo}/${encodeURIComponent(params.ref)}/${encodedPath}`
          : `${this.repoApi(params.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(params.ref)}`;
    const response = await this.request(url, {
      accept: "application/vnd.github.raw",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw await toError(response, params.path);
    return readResponseBodyWithLimit(response, params.maxBytes);
  }

  /** Whether a file or folder exists at a ref. */
  async pathExists(params: {
    repo: string;
    ref: string;
    path: string;
  }): Promise<boolean> {
    const url =
      this.host.provider === "gitlab"
        ? `${this.repoApi(params.repo)}/repository/tree?ref=${encodeURIComponent(params.ref)}&path=${encodeURIComponent(params.path)}&per_page=1`
        : `${this.repoApi(params.repo)}/contents/${params.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(params.ref)}`;
    const response = await this.request(url, {
      method: this.host.provider === "github" ? "HEAD" : "GET",
    });
    if (response.status === 404) return false;
    if (!response.ok) throw await toError(response, params.path);
    if (this.host.provider === "github") return true;
    // GitLab answers an empty list for a missing folder and 404s only for a bad ref.
    const entries = (await response.json()) as unknown[];
    if (entries.length > 0) return true;
    // A file, not a folder: ask the files API.
    const file = await this.request(
      `${this.repoApi(params.repo)}/repository/files/${encodeURIComponent(params.path)}?ref=${encodeURIComponent(params.ref)}`,
      { method: "HEAD" },
    );
    return file.ok;
  }

  /**
   * Repositories the token can write to (GitLab) or the App is installed on
   * (GitHub installation tokens), filtered by `search`.
   */
  async listRepositories(search?: string): Promise<GitRepositorySummary[]> {
    if (this.host.provider === "github") {
      const data = await this.json<{
        repositories: {
          full_name: string;
          private: boolean;
          default_branch?: string;
        }[];
      }>(`${this.host.apiUrl}/installation/repositories?per_page=100`);
      const needle = search?.toLowerCase();
      return data.repositories
        .filter(
          (repo) => !needle || repo.full_name.toLowerCase().includes(needle),
        )
        .map((repo) => ({
          path: repo.full_name,
          private: repo.private,
          defaultBranch: repo.default_branch ?? null,
        }));
    }
    const params = new URLSearchParams({
      membership: "true",
      simple: "true",
      per_page: "100",
      order_by: "last_activity_at",
    });
    if (search) params.set("search", search);
    const projects = await this.json<
      {
        path_with_namespace: string;
        visibility?: string;
        default_branch?: string | null;
      }[]
    >(`${this.host.apiUrl}/projects?${params}`);
    return projects.map((project) => ({
      path: project.path_with_namespace,
      private: project.visibility !== "public",
      defaultBranch: project.default_branch ?? null,
    }));
  }

  // === requests ===

  /** The API path of a repository: GitHub `repos/o/r`, GitLab `projects/<url-encoded path>`. */
  repoApi(repo: string): string {
    return this.host.provider === "github"
      ? `${this.host.apiUrl}/repos/${repo}`
      : `${this.host.apiUrl}/projects/${encodeURIComponent(repo)}`;
  }

  async json<T>(url: string, init?: RequestOptions): Promise<T> {
    const response = await this.request(url, init);
    if (!response.ok) throw await toError(response, url);
    return (await response.json()) as T;
  }

  async request(url: string, init: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept:
        init.accept ??
        (this.host.provider === "github"
          ? "application/vnd.github+json"
          : "application/json"),
      "User-Agent": "archestra-git-sync",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) {
      if (this.host.provider === "gitlab")
        headers["PRIVATE-TOKEN"] = this.token;
      else headers.Authorization = `Bearer ${this.token}`;
    }
    try {
      return await fetch(url, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal ?? AbortSignal.timeout(30_000),
        // Credentials stay on the configured host.
        redirect: url.startsWith("https://raw.githubusercontent.com/")
          ? "follow"
          : "error",
      });
    } catch (error) {
      throw new GitHostError(
        0,
        `Could not reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // === internals ===

  private async text(url: string, init?: RequestOptions): Promise<string> {
    const response = await this.request(url, init);
    if (!response.ok) throw await toError(response, url);
    return response.text();
  }

  private async listGithubTree(
    repo: string,
    commitSha: string,
  ): Promise<GitTreeEntry[]> {
    const data = await this.json<{
      truncated?: boolean;
      tree: { path?: string; type?: string; size?: number }[];
    }>(`${this.repoApi(repo)}/git/trees/${commitSha}?recursive=1`);
    if (data.truncated)
      throw new GitHostError(
        413,
        `${repo} is too large to read in one pass; point at a folder inside it`,
      );
    return data.tree.flatMap((item) =>
      item.path && (item.type === "blob" || item.type === "tree")
        ? [{ path: item.path, type: item.type, size: item.size }]
        : [],
    );
  }

  private async listGitlabTree(
    repo: string,
    commitSha: string,
  ): Promise<GitTreeEntry[]> {
    const entries: GitTreeEntry[] = [];
    let url: string | null =
      `${this.repoApi(repo)}/repository/tree?ref=${commitSha}&recursive=true&per_page=100&pagination=keyset`;
    for (let page = 0; url; page++) {
      if (page >= MAX_GITLAB_TREE_PAGES)
        throw new GitHostError(
          413,
          `${repo} is too large to read in one pass; point at a folder inside it`,
        );
      const response = await this.request(url);
      if (!response.ok) throw await toError(response, repo);
      const items = (await response.json()) as {
        path: string;
        type: string;
      }[];
      for (const item of items)
        if (item.type === "blob" || item.type === "tree")
          entries.push({ path: item.path, type: item.type });
      url = nextLink(response.headers.get("link"));
    }
    return entries;
  }
}

interface RequestOptions {
  method?: string;
  accept?: string;
  body?: unknown;
  signal?: AbortSignal;
}

/** 100 entries a page: 20,000 files is far past any skill or plugin repository. */
const MAX_GITLAB_TREE_PAGES = 200;
const CACHE_SALT = randomBytes(16);
const treeCache = new LRUCacheManager<GitTreeEntry[]>({
  maxSize: 50,
  defaultTtl: 5 * TimeInMs.Minute,
});

/** Never key a cache on a raw token. */
function cacheKey(parts: (string | undefined)[]): string {
  return createHash("sha256")
    .update(CACHE_SALT)
    .update(parts.map((part) => part ?? "").join("\0"))
    .digest("hex");
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function toError(
  response: Response,
  what: string,
): Promise<GitHostError> {
  let detail = "";
  try {
    const body = (await response.json()) as {
      message?: unknown;
      error?: unknown;
    };
    const message = body.message ?? body.error;
    detail =
      typeof message === "string" ? message : JSON.stringify(message ?? "");
  } catch {
    // Not JSON.
  }
  const reason =
    response.status === 401
      ? "the credential was rejected"
      : response.status === 403
        ? "the credential can't read it"
        : response.status === 404
          ? "not found, or the credential can't see it"
          : `HTTP ${response.status}`;
  return new GitHostError(
    response.status,
    `${what}: ${reason}${detail && response.status >= 400 && response.status !== 404 ? ` (${detail.slice(0, 200)})` : ""}`,
  );
}
