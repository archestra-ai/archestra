import { randomBytes, scryptSync } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { Octokit } from "@octokit/rest";
import { LRUCacheManager } from "@/cache-manager";
import {
  isGithubRateLimitError,
  readPublicGithubTree,
} from "./github-public-git";

export interface GithubTreeItem {
  type?: string;
  path?: string;
  size?: number;
  mode?: string;
}

/** Number of immutable Plugin repository trees retained per process. */
const REPO_CACHE_MAX_ENTRIES = 50;
/** Match the existing Skills discover-to-import cache window. */
const REPO_CACHE_TTL_MS = 5 * TimeInMs.Minute;
/** Per-process salt for authentication-context cache fingerprints. */
const REPO_CACHE_SALT = randomBytes(16);

/**
 * Process-local counterpart of the existing Skills repository cache. The key
 * includes the immutable commit and a token fingerprint, so private tree paths
 * cannot leak into an unauthenticated request.
 */
const repoCache = new LRUCacheManager<GithubTreeItem[]>({
  maxSize: REPO_CACHE_MAX_ENTRIES,
  defaultTtl: REPO_CACHE_TTL_MS,
});

class GithubRepositoryTreeService {
  async read(params: {
    owner: string;
    repo: string;
    commitSha: string;
    githubToken?: string;
    signal?: AbortSignal;
  }): Promise<GithubTreeItem[]> {
    const cacheKey = repoCacheKey(params);
    const cached = repoCache.get(cacheKey);
    if (cached) return cached;

    const tree = await this.load(params);
    repoCache.set(cacheKey, tree);
    return tree;
  }

  private async load(params: {
    owner: string;
    repo: string;
    commitSha: string;
    githubToken?: string;
    signal?: AbortSignal;
  }): Promise<GithubTreeItem[]> {
    const octokit = new Octokit({
      ...(params.githubToken ? { auth: params.githubToken } : {}),
      request: { timeout: 10_000 },
    });
    try {
      const response = await octokit.rest.git.getTree({
        owner: params.owner,
        repo: params.repo,
        tree_sha: params.commitSha,
        recursive: "true",
        request: params.signal ? { signal: params.signal } : undefined,
      });
      if (response.data.truncated) {
        throw new Error(
          "Repository tree is too large for a safe recursive read",
        );
      }
      return response.data.tree;
    } catch (error) {
      if (!params.githubToken && isGithubRateLimitError(error)) {
        return readPublicGithubTree({
          repository: {
            owner: params.owner,
            repo: params.repo,
            slug: `${params.owner}/${params.repo}`,
          },
          commitSha: params.commitSha,
          signal: params.signal,
        });
      }
      throw error;
    }
  }
}

function repoCacheKey(params: {
  owner: string;
  repo: string;
  commitSha: string;
  githubToken?: string;
}): string {
  const tokenFingerprint = params.githubToken
    ? fingerprintToken(params.githubToken)
    : "public";
  return `${params.owner}/${params.repo}@${params.commitSha}#${tokenFingerprint}`;
}

function fingerprintToken(token: string): string {
  return scryptSync(token, REPO_CACHE_SALT, 8).toString("hex");
}

export const githubRepositoryTreeService = new GithubRepositoryTreeService();
