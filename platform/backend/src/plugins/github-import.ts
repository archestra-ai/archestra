import { Octokit } from "@octokit/rest";
import {
  PLUGIN_MAX_FILE_BYTES,
  PLUGIN_MAX_TOTAL_BYTES,
  type PluginFileInput,
} from "@/types";
import { readResponseBodyWithLimit } from "./bounded-response";
import {
  isGithubRateLimitError,
  resolvePublicGithubCommit,
} from "./github-public-git";
import { githubRepositoryTreeService } from "./github-tree";
import { collectPluginTreeFiles } from "./plugin-tree-files";

interface ImportedPlugin {
  repo: string;
  requestedRef: string | null;
  commitSha: string;
  subdir: string;
  files: PluginFileInput[];
  skippedFiles: string[];
}

export class PluginImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginImportError";
  }
}

/** Normalize any accepted GitHub repository URL to the stored owner/repo form. */
export function normalizeGithubPluginRepoUrl(repoUrl: string): string {
  const { owner, repo } = parseSource({ repoUrl });
  return `${owner}/${repo}`;
}

/**
 * Resolve one GitHub tree to immutable, by-value plugin bytes. This service
 * never executes or interprets hook configuration and always strips transport
 * configuration (`.mcp.json`) plus repository policy/CI files.
 */
export async function importPluginFromGithub(params: {
  repoUrl: string;
  ref?: string | null;
  /** Branch/tag recorded for future update checks while `ref` may be a SHA. */
  trackingRef?: string | null;
  subdir?: string;
  exclude?: string[];
  githubToken?: string;
  deadlineAt?: number;
}): Promise<ImportedPlugin> {
  const deadlineSignal = params.deadlineAt
    ? AbortSignal.timeout(Math.max(1, params.deadlineAt - Date.now()))
    : undefined;
  const source = parseSource(params);
  const octokit = new Octokit({
    ...(params.githubToken ? { auth: params.githubToken } : {}),
    request: { timeout: 10_000 },
  });
  const requestedRef =
    params.trackingRef !== undefined
      ? params.trackingRef
      : (source.ref ?? params.ref ?? null);
  const ref = requestedRef ?? "HEAD";

  const commitSha = await resolveCommit({
    octokit,
    source,
    ref,
    githubToken: params.githubToken,
    signal: deadlineSignal,
  });
  assertWithinDeadline(params.deadlineAt);
  const tree = await githubRepositoryTreeService
    .read({
      owner: source.owner,
      repo: source.repo,
      commitSha,
      githubToken: params.githubToken,
      signal: deadlineSignal,
    })
    .catch((error) => {
      throw new PluginImportError(
        `Could not read repository tree: ${errorMessage(error)}`,
      );
    });
  assertWithinDeadline(params.deadlineAt);
  const collected = collectPluginTreeFiles({
    tree,
    subdir: source.subdir,
    exclude: params.exclude,
  });
  if (collected.unsafePath) {
    throw new PluginImportError(
      `Repository contains unsafe plugin path: ${collected.unsafePath}`,
    );
  }
  const { candidates, skippedFiles } = collected;

  candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const files: PluginFileInput[] = [];
  let downloadedBytes = 0;
  for (const candidate of candidates) {
    assertWithinDeadline(params.deadlineAt);
    const remainingBytes = Math.min(
      PLUGIN_MAX_FILE_BYTES,
      PLUGIN_MAX_TOTAL_BYTES - downloadedBytes,
    );
    if (remainingBytes <= 0) {
      skippedFiles.push(candidate.relativePath);
      continue;
    }
    const bytes = await fetchRawFile({
      owner: source.owner,
      repo: source.repo,
      commitSha,
      path: candidate.repoPath,
      githubToken: params.githubToken,
      maxBytes: remainingBytes,
      deadlineAt: params.deadlineAt,
      signal: deadlineSignal,
    });
    if (
      bytes === null ||
      bytes.length > PLUGIN_MAX_FILE_BYTES ||
      downloadedBytes + bytes.length > PLUGIN_MAX_TOTAL_BYTES
    ) {
      skippedFiles.push(candidate.relativePath);
      continue;
    }
    downloadedBytes += bytes.length;
    const decoded = decodeContent(bytes);
    files.push({
      path: candidate.relativePath,
      content: decoded.content,
      encoding: decoded.encoding,
      mode: candidate.mode,
    });
  }

  if (files.length === 0) {
    throw new PluginImportError(
      "Imported subtree contains no importable files after exclusions",
    );
  }
  const lowerPaths = files.map((file) => file.path.toLowerCase());
  if (new Set(lowerPaths).size !== lowerPaths.length) {
    throw new PluginImportError(
      "Imported subtree contains file paths that collide ignoring case",
    );
  }

  return {
    repo: `${source.owner}/${source.repo}`,
    requestedRef,
    commitSha,
    subdir: source.subdir,
    files,
    skippedFiles: skippedFiles.sort(),
  };
}

// === Internal helpers ===

async function resolveCommit(params: {
  octokit: Octokit;
  source: { owner: string; repo: string };
  ref: string;
  githubToken?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const repository = {
    owner: params.source.owner,
    repo: params.source.repo,
    slug: `${params.source.owner}/${params.source.repo}`,
  };
  try {
    const response = await params.octokit.rest.repos.getCommit({
      owner: params.source.owner,
      repo: params.source.repo,
      ref: params.ref,
      request: params.signal ? { signal: params.signal } : undefined,
    });
    return response.data.sha;
  } catch (error) {
    if (!params.githubToken && isGithubRateLimitError(error)) {
      try {
        return await resolvePublicGithubCommit({
          repository,
          ref: params.ref === "HEAD" ? null : params.ref,
          signal: params.signal,
        });
      } catch (fallbackError) {
        throw new PluginImportError(
          `Could not resolve ref "${params.ref}" in ${repository.slug} after the anonymous GitHub API quota was exhausted: ${errorMessage(fallbackError)}`,
        );
      }
    }
    throw new PluginImportError(
      `Could not resolve ref "${params.ref}" in ${repository.slug}: ${errorMessage(error)}`,
    );
  }
}

function parseSource(params: { repoUrl: string; subdir?: string }): {
  owner: string;
  repo: string;
  ref: string | null;
  subdir: string;
} {
  const withoutProtocol = params.repoUrl
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/, "");
  const segments = withoutProtocol.split("/").filter(Boolean);
  if (segments.length < 2 || segments[0].includes(".")) {
    throw new PluginImportError(
      "Repository must be on github.com and include an owner and repository",
    );
  }
  const [owner, repo, ...rest] = segments;
  const urlRef = rest[0] === "tree" && rest[1] ? rest[1] : null;
  const urlSubdir = urlRef ? rest.slice(2).join("/") : "";
  return {
    owner,
    repo,
    ref: urlRef,
    subdir: normalizeSubdir(params.subdir ?? urlSubdir),
  };
}

function normalizeSubdir(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (
    normalized.includes("\\") ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new PluginImportError("Subdirectory must be a safe relative path");
  }
  return normalized;
}

async function fetchRawFile(params: {
  owner: string;
  repo: string;
  commitSha: string;
  path: string;
  githubToken?: string;
  maxBytes: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}): Promise<Buffer | null> {
  const encodedPath = params.path.split("/").map(encodeURIComponent).join("/");
  const timeoutMs = params.deadlineAt
    ? Math.min(10_000, params.deadlineAt - Date.now())
    : 10_000;
  if (timeoutMs <= 0) throw new PluginImportError("Plugin import timed out");
  let response: Response;
  try {
    response = await fetch(
      `https://raw.githubusercontent.com/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/${params.commitSha}/${encodedPath}`,
      {
        headers: params.githubToken
          ? { Authorization: `Bearer ${params.githubToken}` }
          : undefined,
        signal: params.signal
          ? AbortSignal.any([params.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (error) {
    throw new PluginImportError(
      `Could not fetch ${params.path}: ${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    throw new PluginImportError(
      `Could not fetch ${params.path}: GitHub returned ${response.status}`,
    );
  }
  return readResponseBodyWithLimit(response, params.maxBytes);
}

function decodeContent(bytes: Buffer): {
  content: string;
  encoding: "utf8" | "base64";
} {
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf8",
    };
  } catch {
    return { content: bytes.toString("base64"), encoding: "base64" };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertWithinDeadline(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new PluginImportError("Plugin import timed out");
  }
}
