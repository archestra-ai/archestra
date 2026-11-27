import {
  GIT_HOST_RATE_LIMITED_CODE,
  GIT_REPOSITORY_NOT_FOUND_CODE,
  type GitHost,
  type GitProvider,
  gitHostFromUrl,
  isCloudGitHost,
  parseGitRepoUrl,
} from "@archestra/shared";
import { Octokit } from "@octokit/rest";
import type { GitAccess } from "@/git-hosts/git-access";
import {
  GitHostClient,
  GitReadError,
  gitReadFailureCode,
} from "@/git-hosts/git-host-client";
import { readResponseBodyWithLimit } from "./bounded-response";
import {
  isGithubRateLimitError,
  resolvePublicGithubCommit,
} from "./github-public-git";
import {
  type GithubTreeItem,
  githubRepositoryTreeService,
} from "./github-tree";

/**
 * Read-only access to the repositories of one Git host, for plugin imports
 * and marketplace discovery. `repo` is the repository path: `owner/repo`, or
 * a nested GitLab `group/sub/project`. Errors carry user-facing messages.
 */
export interface PluginRepoReader {
  readonly host: GitHost;
  /** The commit a branch, tag, or SHA points at; null `ref` means the default branch. */
  resolveCommit(params: {
    repo: string;
    ref: string | null;
    signal?: AbortSignal;
  }): Promise<string>;
  /** Every file and folder at a commit. */
  readTree(params: {
    repo: string;
    commitSha: string;
    signal?: AbortSignal;
  }): Promise<GithubTreeItem[]>;
  /** The first of `paths` that exists as a file at the commit, or null. */
  findFirstFile(params: {
    repo: string;
    commitSha: string;
    paths: readonly string[];
  }): Promise<string | null>;
  /** A file's bytes; null when it exceeds `maxBytes` (or, off github.com, is missing). */
  readFile(params: {
    repo: string;
    commitSha: string;
    path: string;
    maxBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Buffer | null>;
  /** A file's size in bytes, for trees that do not report sizes. */
  fileSize(params: {
    repo: string;
    commitSha: string;
    path: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<number>;
}

/**
 * The reader for an access; none means public github.com. github.com keeps
 * its anonymous rate-limit fallbacks (raw.githubusercontent.com and public
 * Git), while GitHub Enterprise Server and GitLab read through the shared Git
 * host client.
 */
export function createPluginRepoReader(access?: GitAccess): PluginRepoReader {
  const host = access?.host ?? gitHostFromUrl({ provider: "github" });
  return isGithubCloud(host)
    ? new GithubCloudReader(access?.token)
    : new GitHostReader(new GitHostClient(host, access?.token));
}

/**
 * Parse a repository URL (`owner/repo`, a nested GitLab path, or a full URL
 * with an optional `/tree/<ref>/<path>` or `/-/tree/<ref>/<path>`) against the
 * host it must belong to.
 */
export function parsePluginRepoUrl(params: {
  repoUrl: string;
  host: GitHost;
}): { path: string; ref: string | null; subpath: string } {
  const location = parseGitRepoUrl({
    input: params.repoUrl,
    host: params.host,
  });
  if (
    location.path.split("/").some((segment) => /^\.+$/.test(segment)) ||
    location.subpath.split("/").some((segment) => segment === "..")
  ) {
    throw new Error("Invalid repository path");
  }
  return {
    path: location.path,
    ref: location.ref,
    subpath: location.subpath,
  };
}

/** The provider and recorded origin (null for the provider's cloud) of a host. */
export function pluginSourceHost(host: GitHost): {
  sourceProvider: GitProvider;
  sourceOrigin: string | null;
} {
  return {
    sourceProvider: host.provider,
    sourceOrigin: isCloudGitHost(host) ? null : host.webUrl,
  };
}

export function isGithubCloud(host: GitHost): boolean {
  return host.provider === "github" && isCloudGitHost(host);
}

// === Internal helpers ===

/**
 * github.com, through Octokit and raw.githubusercontent.com. Once the
 * anonymous REST quota runs out, later lookups go straight to public Git.
 */
class GithubCloudReader implements PluginRepoReader {
  readonly host = gitHostFromUrl({ provider: "github" });
  private readonly octokit: Octokit;
  private anonymousRateLimited = false;

  constructor(private readonly token?: string) {
    this.octokit = new Octokit({
      ...(token ? { auth: token } : {}),
      request: { timeout: 10_000 },
    });
  }

  async resolveCommit(params: {
    repo: string;
    ref: string | null;
    signal?: AbortSignal;
  }): Promise<string> {
    const repository = githubRepository(params.repo);
    const ref = params.ref ?? "HEAD";
    if (!this.token && this.anonymousRateLimited) {
      return this.resolvePublicCommit({ ...params, repository, ref });
    }
    try {
      const response = await this.octokit.rest.repos.getCommit({
        owner: repository.owner,
        repo: repository.repo,
        ref,
        request: params.signal ? { signal: params.signal } : undefined,
      });
      return response.data.sha;
    } catch (error) {
      if (!this.token && isGithubRateLimitError(error)) {
        this.anonymousRateLimited = true;
        return this.resolvePublicCommit({ ...params, repository, ref });
      }
      if (githubStatus(error) === 404) {
        throw new GitReadError(
          `${
            ref === "HEAD"
              ? `Repository ${repository.slug} was not found`
              : `"${ref}" was not found in ${repository.slug}`
          }${this.token ? ", or the credential can't see it." : "."}`,
          // A named ref that is missing is not a missing repository.
          ref === "HEAD" ? GIT_REPOSITORY_NOT_FOUND_CODE : null,
        );
      }
      throw new GitReadError(
        `Could not read ${repository.slug}: ${githubFailureReason(error)}`,
        isGithubRateLimitError(error) ? GIT_HOST_RATE_LIMITED_CODE : null,
      );
    }
  }

  readTree(params: {
    repo: string;
    commitSha: string;
    signal?: AbortSignal;
  }): Promise<GithubTreeItem[]> {
    const repository = githubRepository(params.repo);
    return githubRepositoryTreeService.read({
      owner: repository.owner,
      repo: repository.repo,
      commitSha: params.commitSha,
      githubToken: this.token,
      signal: params.signal,
    });
  }

  async findFirstFile(params: {
    repo: string;
    commitSha: string;
    paths: readonly string[];
  }): Promise<string | null> {
    const repository = githubRepository(params.repo);
    if (!this.token && this.anonymousRateLimited) {
      return this.probeRawFiles(params);
    }
    try {
      const response = await this.octokit.rest.git.getTree({
        owner: repository.owner,
        repo: repository.repo,
        tree_sha: params.commitSha,
        recursive: "true",
      });
      if (response.data.truncated) {
        throw new TreeTooLargeError();
      }
      const files = new Set(
        response.data.tree
          .filter((item) => item.type === "blob" && item.path)
          .map((item) => item.path as string),
      );
      return params.paths.find((path) => files.has(path)) ?? null;
    } catch (error) {
      if (error instanceof TreeTooLargeError) throw error;
      if (!this.token && isGithubRateLimitError(error)) {
        this.anonymousRateLimited = true;
        return this.probeRawFiles(params);
      }
      throw new Error(
        `Could not read repository tree: ${githubFailureReason(error)}`,
      );
    }
  }

  async readFile(params: {
    repo: string;
    commitSha: string;
    path: string;
    maxBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Buffer | null> {
    let response: Response;
    try {
      response = await fetch(this.rawUrl(params), {
        headers: this.token
          ? { Authorization: `Bearer ${this.token}` }
          : undefined,
        signal: withTimeout(params.signal, params.timeoutMs),
      });
    } catch (error) {
      throw new Error(errorMessage(error));
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readResponseBodyWithLimit(response, params.maxBytes);
  }

  async fileSize(params: {
    repo: string;
    commitSha: string;
    path: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<number> {
    const response = await fetch(this.rawUrl(params), {
      method: "HEAD",
      headers: this.token
        ? { Authorization: `Bearer ${this.token}` }
        : undefined,
      signal: withTimeout(params.signal, params.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} for ${params.path}`);
    }
    const size = Number(response.headers.get("content-length"));
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`GitHub omitted Content-Length for ${params.path}`);
    }
    return size;
  }

  private async resolvePublicCommit(params: {
    repository: GithubRepository;
    ref: string;
    signal?: AbortSignal;
  }): Promise<string> {
    try {
      return await resolvePublicGithubCommit({
        repository: params.repository,
        ref: params.ref === "HEAD" ? null : params.ref,
        signal: params.signal,
      });
    } catch (error) {
      // Git's own words ("remote: Repository not found. fatal: ...") are for
      // a terminal. A repository Git cannot find is the same answer the API
      // gives with 404; anything else is the quota, which is why this path
      // ran at all.
      if (/repository[^\n]*not found/i.test(errorMessage(error))) {
        throw new GitReadError(
          `Repository ${params.repository.slug} was not found.`,
          GIT_REPOSITORY_NOT_FOUND_CODE,
        );
      }
      // The repository answered and has no such branch or tag: the name is
      // the thing to correct, not the access and not the time of day.
      if (/returned no commit/i.test(errorMessage(error))) {
        throw new GitReadError(
          `${params.repository.slug} has no branch or tag named "${params.ref}".`,
        );
      }
      throw new GitReadError(
        `Could not read ${params.repository.slug}: GitHub's request limit is used up, and reading it over Git failed too. Try again later.`,
        GIT_HOST_RATE_LIMITED_CODE,
      );
    }
  }

  private async probeRawFiles(params: {
    repo: string;
    commitSha: string;
    paths: readonly string[];
  }): Promise<string | null> {
    for (const path of params.paths) {
      let response: Response;
      try {
        response = await fetch(this.rawUrl({ ...params, path }), {
          method: "HEAD",
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        throw new Error(`Could not probe ${path}: ${errorMessage(error)}`);
      }
      if (response.status === 404) continue;
      if (!response.ok) {
        throw new Error(
          `Could not probe ${path}: GitHub returned ${response.status}`,
        );
      }
      return path;
    }
    return null;
  }

  private rawUrl(params: {
    repo: string;
    commitSha: string;
    path: string;
  }): string {
    const repository = githubRepository(params.repo);
    const encodedPath = params.path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return `https://raw.githubusercontent.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${params.commitSha}/${encodedPath}`;
  }
}

/** GitHub Enterprise Server and GitLab (cloud or self-managed). */
class GitHostReader implements PluginRepoReader {
  constructor(private readonly client: GitHostClient) {}

  get host(): GitHost {
    return this.client.host;
  }

  async resolveCommit(params: {
    repo: string;
    ref: string | null;
    signal?: AbortSignal;
  }): Promise<string> {
    try {
      return await abortable(
        this.client.resolveCommit(params.repo, params.ref),
        params.signal,
      );
    } catch (error) {
      const code = gitReadFailureCode(error, { lookup: params.ref === null });
      throw new GitReadError(
        code === GIT_REPOSITORY_NOT_FOUND_CODE
          ? `Repository ${params.repo} was not found, or the credential can't see it.`
          : `Could not read ${params.repo}: ${errorMessage(error)}`,
        code,
      );
    }
  }

  readTree(params: {
    repo: string;
    commitSha: string;
    signal?: AbortSignal;
  }): Promise<GithubTreeItem[]> {
    return abortable(
      this.client.listTree(params.repo, params.commitSha),
      params.signal,
    );
  }

  async findFirstFile(params: {
    repo: string;
    commitSha: string;
    paths: readonly string[];
  }): Promise<string | null> {
    let tree: GithubTreeItem[];
    try {
      tree = await this.readTree(params);
    } catch (error) {
      throw new Error(`Could not read repository tree: ${errorMessage(error)}`);
    }
    const files = new Set(
      tree
        .filter((item) => item.type === "blob" && item.path)
        .map((item) => item.path as string),
    );
    return params.paths.find((path) => files.has(path)) ?? null;
  }

  readFile(params: {
    repo: string;
    commitSha: string;
    path: string;
    maxBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Buffer | null> {
    return abortable(
      this.client.readFile({
        repo: params.repo,
        ref: params.commitSha,
        path: params.path,
        maxBytes: params.maxBytes,
      }),
      withTimeout(params.signal, params.timeoutMs),
    );
  }

  async fileSize(params: {
    repo: string;
    commitSha: string;
    path: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<number> {
    const signal = withTimeout(params.signal, params.timeoutMs);
    if (this.host.provider === "github") {
      const file = await this.client.json<{ size?: unknown }>(
        `${this.client.repoApi(params.repo)}/contents/${params.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(params.commitSha)}`,
        { signal },
      );
      if (typeof file.size !== "number" || file.size < 0) {
        throw new Error(`GitHub omitted the size of ${params.path}`);
      }
      return file.size;
    }
    const response = await this.client.request(
      `${this.client.repoApi(params.repo)}/repository/files/${encodeURIComponent(params.path)}?ref=${encodeURIComponent(params.commitSha)}`,
      { method: "HEAD", signal },
    );
    if (!response.ok) {
      throw new Error(`GitLab returned ${response.status} for ${params.path}`);
    }
    const size = Number(response.headers.get("x-gitlab-size"));
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`GitLab omitted the size of ${params.path}`);
    }
    return size;
  }
}

interface GithubRepository {
  owner: string;
  repo: string;
  slug: string;
}

class TreeTooLargeError extends Error {
  constructor() {
    super("Repository tree is too large for marketplace discovery");
    this.name = "TreeTooLargeError";
  }
}

function githubRepository(path: string): GithubRepository {
  const [owner, repo] = path.split("/");
  return { owner, repo, slug: path };
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Settle with the operation, or reject as soon as `signal` aborts. */
async function abortable<Value>(
  operation: Promise<Value>,
  signal: AbortSignal | undefined,
): Promise<Value> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<Value>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("Aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function githubStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * Why a GitHub API call failed, in words for the person who typed the
 * repository. The API's own message is written for a developer reading a
 * response: it ends in a documentation link, and its rate-limit text names
 * the address the request came from.
 */
function githubFailureReason(error: unknown): string {
  if (isGithubRateLimitError(error)) {
    return "GitHub's request limit is used up. Try again later.";
  }
  switch (githubStatus(error)) {
    case 401:
      return "the credential was rejected";
    case 403:
      return "the credential can't read it";
    case 404:
      return "not found, or the credential can't see it";
    default:
      return errorMessage(error).replace(
        /\s*-\s*https:\/\/docs\.github\.com\S*/g,
        "",
      );
  }
}
