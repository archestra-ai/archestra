import { LRUCacheManager } from "@/cache-manager";
import {
  type GitAccess,
  resolveGitCredentialAccess,
} from "@/git-hosts/git-access";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import {
  expandRepositoryIncludes,
  isRepositoryInclude,
  repositoryFileHash,
  repositoryIncludePaths,
  withoutRepositoryIncludes,
} from "@/openappa/policy-text";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import { openappaGitlab } from "@/services/openappa-gitlab";
import {
  resolveGithubPatToken,
  resolveGithubSkillAppCredentials,
} from "@/skills/github-app-token";
import { GITHUB_DOT_COM_SOURCE } from "@/skills/github-source";
import { ApiError } from "@/types";
import { mapWithConcurrency } from "@/utils/concurrency";

/**
 * The token and GitHub origins for an OpenAPPA policy source. A GitHub App
 * carries its own API URL, so GitHub Enterprise Server works like github.com;
 * personal access tokens and public reads are github.com only.
 */
export async function resolveOpenAppaGithubAccess(source: {
  organizationId: string;
  githubPatId: string | null;
  githubAppConfigId: string | null;
}): Promise<OpenAppaGithubAccess> {
  if (source.githubAppConfigId) {
    const { githubToken, githubSource } =
      await resolveGithubSkillAppCredentials({
        organizationId: source.organizationId,
        githubAppConfigId: source.githubAppConfigId,
      });
    return {
      token: githubToken,
      api: githubSource.apiBaseUrl,
      web: githubSource.webOrigin,
    };
  }
  const origins = {
    api: GITHUB_DOT_COM_SOURCE.apiBaseUrl,
    web: GITHUB_DOT_COM_SOURCE.webOrigin,
  };
  if (source.githubPatId)
    return {
      token: await resolveGithubPatToken({
        organizationId: source.organizationId,
        githubPatId: source.githubPatId,
      }),
      ...origins,
    };
  return { token: undefined, ...origins };
}

/** The GitLab host and token behind a source's GitLab token. */
export async function resolveOpenAppaGitlabAccess(source: {
  organizationId: string;
  gitlabTokenId: string;
}): Promise<GitAccess> {
  const access = await resolveGitCredentialAccess({
    organizationId: source.organizationId,
    credentialId: source.gitlabTokenId,
  });
  if (access.host.provider !== "gitlab")
    throw new ApiError(400, "The policy source's credential is not for GitLab");
  return access;
}

type OpenAppaGithubAccess = {
  token: string | undefined;
  /** API base, e.g. https://api.github.com or https://github.example.com/api/v3. */
  api: string;
  /** Web origin, e.g. https://github.com. */
  web: string;
};

// =============================================================================
// Repository includes: the policy repository's files appa.toml includes
// =============================================================================

/** The largest included file read, the same limit as the policy file's. */
const FILE_MAX_BYTES = 1024 * 1024;

/** The repository a policy source reads, and the credential it reads with. */
export type RepositorySource = {
  organizationId: string;
  repo: string;
  /** The policy file's path: include entries are relative to its folder. */
  path: string | null;
  githubPatId: string | null;
  githubAppConfigId: string | null;
  gitlabTokenId: string | null;
};

/** A root with its repository includes folded in, or why they could not be. */
export type ExpandedRoot = {
  content: string;
  errors: string[];
  /** Each included file and the hash of the bytes folded in, in include order. */
  included: Array<{ path: string; sha256: string }>;
};

/**
 * The bytes of the repository files a root includes. They are read at the
 * commit Git sync accepted and kept in memory by that commit: the bytes under
 * one commit never change, so a cached file is never stale, and nothing is
 * stored in the database.
 */
class OpenAppaRepositoryIncludes {
  private readonly cache = new LRUCacheManager<string>({
    maxSize: 1024,
    maxBytes: 64 * 1024 * 1024,
    sizeOf: (text) => text.length,
    defaultTtl: 0,
  });
  /**
   * A read that failed, for a minute: every composition that cannot read the
   * repository is refused anyway, so it is not asked again on each call.
   */
  private readonly failures = new LRUCacheManager<string>({
    maxSize: 256,
    defaultTtl: 60_000,
  });

  /** Whether an `include` entry names a file in the policy repository. */
  isRepositoryFile(entry: string): boolean {
    return isRepositoryInclude(entry);
  }

  /** The root without its repository includes. */
  withoutFiles(content: string): string {
    return withoutRepositoryIncludes(content);
  }

  /**
   * Fold the repository files `content` includes into it. A file given in
   * `files` is used as given, which is how a preview checks a proposed file;
   * every other file is read at the accepted commit.
   */
  async expand(params: {
    organizationId: string;
    content: string;
    files?: ReadonlyMap<string, string>;
  }): Promise<ExpandedRoot> {
    const paths = repositoryIncludePaths(params.content);
    if (paths.length === 0)
      return { content: params.content, errors: [], included: [] };
    const files = new Map(params.files ?? []);
    const missing = [...new Set(paths)].filter((path) => !files.has(path));
    if (missing.length > 0) {
      try {
        const accepted = await this.readAccepted({
          organizationId: params.organizationId,
          paths: missing,
        });
        for (const [path, text] of accepted) files.set(path, text);
      } catch (error) {
        if (error instanceof ApiError)
          return {
            content: params.content,
            errors: [error.message],
            included: [],
          };
        throw error;
      }
    }
    return fold({ content: params.content, files });
  }

  /**
   * Fold in the files of one commit, read with `read`: a path the commit does
   * not hold refuses the fold, rather than being read anywhere else.
   */
  foldAt(params: {
    content: string;
    files: ReadonlyMap<string, string>;
  }): ExpandedRoot {
    return fold(params);
  }

  /** Files at the commit Git sync accepted; a path not there is left out. */
  async readAccepted(params: {
    organizationId: string;
    paths: readonly string[];
  }): Promise<Map<string, string>> {
    const source = await OpenAppaGithubSyncModel.find(params.organizationId);
    if (!source?.repo || !source.sourceCommit)
      throw new ApiError(
        409,
        `include: ${JSON.stringify(params.paths[0])} is a file in the policy repository, and Git sync has accepted no repository commit. Connect Git sync, or remove the include.`,
      );
    return this.read({
      source: { ...source, repo: source.repo },
      commit: source.sourceCommit,
      paths: params.paths,
    });
  }

  /**
   * Files at `commit` in the source's repository, by include entry; an entry
   * the commit holds no file for is left out.
   */
  async read(params: {
    source: RepositorySource;
    commit: string;
    paths: readonly string[];
  }): Promise<Map<string, string>> {
    const { source, commit } = params;
    const files = new Map<string, string>();
    const misses: string[] = [];
    for (const path of params.paths) {
      const cached = this.cache.get(cacheKey(source, commit, path));
      if (cached === undefined) misses.push(path);
      else files.set(path, cached);
    }
    if (misses.length === 0) return files;
    const failureKey = cacheKey(source, commit, "");
    const failed = this.failures.get(failureKey);
    if (failed !== undefined) throw new ApiError(502, failed);
    try {
      const read = await fileReader(source);
      const settled = await mapWithConcurrency(misses, 8, (path) =>
        read(commit, repositoryPath(source, path)),
      );
      for (const [index, result] of settled.entries()) {
        if (result.status === "rejected") throw result.reason;
        const path = misses[index] as string;
        if (result.value === null) continue;
        this.cache.set(cacheKey(source, commit, path), result.value);
        files.set(path, result.value);
      }
    } catch (error) {
      if (error instanceof ApiError && error.statusCode >= 500)
        this.failures.set(failureKey, error.message);
      throw error;
    }
    return files;
  }
}

/** Where an include entry sits in the repository: beside the policy file. */
export function repositoryPath(
  source: Pick<RepositorySource, "path">,
  entry: string,
): string {
  const slash = source.path?.lastIndexOf("/") ?? -1;
  return slash > 0 ? `${source.path?.slice(0, slash)}/${entry}` : entry;
}

export const openappaRepositoryIncludes = new OpenAppaRepositoryIncludes();

function fold(params: {
  content: string;
  files: ReadonlyMap<string, string>;
}): ExpandedRoot {
  const expanded = expandRepositoryIncludes(params);
  if (expanded.errors.length > 0) return { ...expanded, included: [] };
  return {
    ...expanded,
    included: [...new Set(repositoryIncludePaths(params.content))].map(
      (path) => ({
        path,
        sha256: repositoryFileHash(params.files.get(path) as string),
      }),
    ),
  };
}

function cacheKey(source: RepositorySource, commit: string, path: string) {
  return [source.organizationId, source.repo, commit, path].join("\u0000");
}

/** Reads one file at a commit; null when the repository has no such file. */
async function fileReader(
  source: RepositorySource,
): Promise<(commit: string, path: string) => Promise<string | null>> {
  if (source.gitlabTokenId) {
    const access = await resolveOpenAppaGitlabAccess({
      organizationId: source.organizationId,
      gitlabTokenId: source.gitlabTokenId,
    });
    return async (commit, path) => {
      try {
        return (
          await openappaGitlab.readPolicy({
            access,
            repo: source.repo,
            ref: commit,
            path,
          })
        ).content;
      } catch (error) {
        // A missing file, or one over the limit, is a 400 there.
        if (error instanceof ApiError && error.statusCode === 400) return null;
        throw error;
      }
    };
  }
  const { token, api } = await resolveOpenAppaGithubAccess(source);
  return async (commit, path) => {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    let response: Response;
    try {
      response = await fetch(
        `${api}/repos/${source.repo}/contents/${encoded}?ref=${commit}`,
        {
          headers: {
            Accept: "application/vnd.github.raw+json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new ApiError(502, `Could not reach GitHub to read ${path}`);
    }
    if (response.status === 404) return null;
    if (!response.ok)
      throw new ApiError(
        502,
        `GitHub returned HTTP ${response.status} for ${path}. Check repository access.`,
      );
    const bytes = await readResponseBodyWithLimit(response, FILE_MAX_BYTES);
    if (!bytes) throw new ApiError(400, `${path} exceeds the 1 MiB limit`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ApiError(400, `${path} is not UTF-8 text`);
    }
  };
}
