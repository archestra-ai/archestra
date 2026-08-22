import { PLUGIN_MARKETPLACE_DISCOVERY_LIMIT } from "@archestra/shared";
import { Octokit } from "@octokit/rest";
import type {
  ClientType,
  PluginMarketplaceDiscovery,
  PluginMarketplaceDiscoveryEntry,
} from "@/types";
import { readResponseBodyWithLimit } from "./bounded-response";
import {
  isGithubRateLimitError,
  resolvePublicGithubCommit,
} from "./github-public-git";
import {
  type GithubTreeItem,
  githubRepositoryTreeService,
} from "./github-tree";
import { collectPluginTreeFiles } from "./plugin-tree-files";

const MARKETPLACE_PATHS = [
  ".claude-plugin/marketplace.json",
  ".github/plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "marketplace.json",
] as const;

const MAX_MARKETPLACE_BYTES = 1024 * 1024;
const MARKETPLACE_RESOLVE_CONCURRENCY = 8;
const MAX_MARKETPLACE_SOURCE_TREES = 25;
const MAX_MARKETPLACE_SIZE_PROBES = 5_000;
const MARKETPLACE_DISCOVERY_DEADLINE_MS = 5 * 60_000;

export class MarketplaceDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceDiscoveryError";
  }
}

/**
 * Reads marketplace metadata without fetching plugin payloads or executing any
 * repository content. Every usable source is pinned to an immutable commit.
 */
export async function discoverGithubMarketplace(params: {
  repoUrl: string;
  ref?: string | null;
  marketplacePath?: string;
  githubToken?: string;
}): Promise<PluginMarketplaceDiscovery> {
  const deadlineAt = Date.now() + MARKETPLACE_DISCOVERY_DEADLINE_MS;
  const deadlineSignal = AbortSignal.timeout(MARKETPLACE_DISCOVERY_DEADLINE_MS);
  const repository = parseRepositoryUrl(params.repoUrl);
  const ref = repository.ref ?? params.ref ?? null;
  const octokit = new Octokit({
    ...(params.githubToken ? { auth: params.githubToken } : {}),
    request: { timeout: 10_000 },
  });
  let anonymousRateLimited = false;
  const pendingCommits = new Map<string, Promise<string>>();
  const externalCommitKeys = new Set<string>();
  const marketplaceCommitKey = `${repository.slug}@${ref ?? "HEAD"}`;
  const resolveRepositoryCommit = async (
    target: RepositoryLocation,
    targetRef: string | null,
  ): Promise<string> => {
    const key = `${target.slug}@${targetRef ?? "HEAD"}`;
    const pending = pendingCommits.get(key);
    if (pending) return pending;
    if (key !== marketplaceCommitKey && !externalCommitKeys.has(key)) {
      if (externalCommitKeys.size >= MAX_MARKETPLACE_SOURCE_TREES) {
        throw new MarketplaceDiscoveryError(
          `Marketplace exceeds the ${MAX_MARKETPLACE_SOURCE_TREES}-repository inspection budget`,
        );
      }
      externalCommitKeys.add(key);
    }
    const resolution = resolveCommit({
      octokit,
      repository: target,
      ref: targetRef,
      githubToken: params.githubToken,
      preferPublicGit: anonymousRateLimited,
      signal: deadlineSignal,
    })
      .then(({ sha, usedPublicFallback }) => {
        if (usedPublicFallback) anonymousRateLimited = true;
        return sha;
      })
      .finally(() => pendingCommits.delete(key));
    pendingCommits.set(key, resolution);
    return resolution;
  };

  const commitSha = await resolveRepositoryCommit(repository, ref);
  const resolvedMarketplace = await resolveMarketplacePath({
    octokit,
    repository,
    commitSha,
    requestedPath: params.marketplacePath,
    githubToken: params.githubToken,
    preferPublicGit: anonymousRateLimited,
  });
  if (resolvedMarketplace.usedPublicFallback) anonymousRateLimited = true;
  const marketplacePath = resolvedMarketplace.path;

  if (!marketplacePath) {
    return {
      repoUrl: repository.slug,
      ref,
      commitSha,
      marketplacePath: null,
      entries: [],
      reason: "No supported marketplace manifest was found",
    };
  }

  const raw = await fetchManifest({
    repository,
    commitSha,
    marketplacePath,
    githubToken: params.githubToken,
  });
  if (raw === null) {
    return {
      repoUrl: repository.slug,
      ref,
      commitSha,
      marketplacePath,
      entries: [],
      reason: "Marketplace manifest could not be read as UTF-8 JSON",
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return {
      repoUrl: repository.slug,
      ref,
      commitSha,
      marketplacePath,
      entries: [],
      reason: "Marketplace manifest is not valid JSON",
    };
  }

  const plugins = marketplaceEntries(manifest);
  if (!plugins) {
    return {
      repoUrl: repository.slug,
      ref,
      commitSha,
      marketplacePath,
      entries: [],
      reason: "Marketplace manifest must contain a plugins array",
    };
  }
  if (plugins.length > PLUGIN_MARKETPLACE_DISCOVERY_LIMIT) {
    throw new MarketplaceDiscoveryError(
      `Marketplace advertises ${plugins.length} plugins; the discovery limit is ${PLUGIN_MARKETPLACE_DISCOVERY_LIMIT}`,
    );
  }

  const clientType = inferClientType({ marketplacePath, manifest });
  const normalized = await mapWithConcurrency(
    plugins,
    MARKETPLACE_RESOLVE_CONCURRENCY,
    (plugin) =>
      normalizeEntry({
        plugin,
        marketplacePath,
        clientType,
        repository,
        ref,
        commitSha,
        resolveCommit: resolveRepositoryCommit,
      }),
  );
  const nameCounts = new Map<string, number>();
  for (const entry of normalized) {
    if (entry.name)
      nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const deduplicated = normalized.map((entry) =>
    entry.name && (nameCounts.get(entry.name) ?? 0) > 1
      ? {
          ...entry,
          supported: false,
          reason: `Marketplace contains duplicate plugin name "${entry.name}"`,
        }
      : entry,
  );
  const entries = await attachFileCounts({
    entries: deduplicated,
    githubToken: params.githubToken,
    deadlineAt,
    signal: deadlineSignal,
  });

  return {
    repoUrl: repository.slug,
    ref,
    commitSha,
    marketplacePath,
    entries,
    reason: null,
  };
}

// === Internal helpers ===

interface RepositoryLocation {
  owner: string;
  repo: string;
  slug: string;
  ref: string | null;
}

function parseRepositoryUrl(value: string): RepositoryLocation {
  const withoutProtocol = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/, "");
  const segments = withoutProtocol.split("/").filter(Boolean);
  if (segments.length < 2 || segments[0].includes(".")) {
    throw new MarketplaceDiscoveryError(
      "Repository must be on github.com and include an owner and repository",
    );
  }
  const [owner, repo, ...rest] = segments;
  const ref = rest[0] === "tree" && rest[1] ? rest[1] : null;
  return { owner, repo, slug: `${owner}/${repo}`, ref };
}

async function resolveCommit(params: {
  octokit: Octokit;
  repository: RepositoryLocation;
  ref: string | null;
  githubToken?: string;
  preferPublicGit: boolean;
  signal?: AbortSignal;
}): Promise<{ sha: string; usedPublicFallback: boolean }> {
  const ref = params.ref ?? "HEAD";
  if (!params.githubToken && params.preferPublicGit) {
    return {
      sha: await resolvePublicGithubCommit({
        repository: params.repository,
        ref: params.ref,
        signal: params.signal,
      }),
      usedPublicFallback: true,
    };
  }
  try {
    const response = await params.octokit.rest.repos.getCommit({
      owner: params.repository.owner,
      repo: params.repository.repo,
      ref,
      request: params.signal ? { signal: params.signal } : undefined,
    });
    return { sha: response.data.sha, usedPublicFallback: false };
  } catch (error) {
    if (!params.githubToken && isGithubRateLimitError(error)) {
      try {
        return {
          sha: await resolvePublicGithubCommit({
            repository: params.repository,
            ref: params.ref,
            signal: params.signal,
          }),
          usedPublicFallback: true,
        };
      } catch (fallbackError) {
        throw new MarketplaceDiscoveryError(
          `Could not resolve ref "${ref}" in ${params.repository.slug} after the anonymous GitHub API quota was exhausted: ${errorMessage(fallbackError)}`,
        );
      }
    }
    throw new MarketplaceDiscoveryError(
      `Could not resolve ref "${ref}" in ${params.repository.slug}: ${errorMessage(error)}`,
    );
  }
}

async function resolveMarketplacePath(params: {
  octokit: Octokit;
  repository: RepositoryLocation;
  commitSha: string;
  requestedPath?: string;
  githubToken?: string;
  preferPublicGit: boolean;
}): Promise<{ path: string | null; usedPublicFallback: boolean }> {
  const paths = params.requestedPath
    ? [validateMarketplacePath(params.requestedPath)]
    : [...MARKETPLACE_PATHS];
  if (!params.githubToken && params.preferPublicGit) {
    return {
      path: await resolveMarketplacePathFromRaw({
        repository: params.repository,
        commitSha: params.commitSha,
        paths,
      }),
      usedPublicFallback: true,
    };
  }
  try {
    const response = await params.octokit.rest.git.getTree({
      owner: params.repository.owner,
      repo: params.repository.repo,
      tree_sha: params.commitSha,
      recursive: "true",
    });
    if (response.data.truncated) {
      throw new MarketplaceDiscoveryError(
        "Repository tree is too large for marketplace discovery",
      );
    }
    const files = new Set(
      response.data.tree
        .filter((item) => item.type === "blob" && item.path)
        .map((item) => item.path as string),
    );
    return {
      path: paths.find((path) => files.has(path)) ?? null,
      usedPublicFallback: false,
    };
  } catch (error) {
    if (error instanceof MarketplaceDiscoveryError) throw error;
    if (!params.githubToken && isGithubRateLimitError(error)) {
      return {
        path: await resolveMarketplacePathFromRaw({
          repository: params.repository,
          commitSha: params.commitSha,
          paths,
        }),
        usedPublicFallback: true,
      };
    }
    throw new MarketplaceDiscoveryError(
      `Could not read repository tree: ${errorMessage(error)}`,
    );
  }
}

async function resolveMarketplacePathFromRaw(params: {
  repository: RepositoryLocation;
  commitSha: string;
  paths: string[];
}): Promise<string | null> {
  for (const path of params.paths) {
    let response: Response;
    try {
      response = await fetch(
        rawGithubUrl({
          repository: params.repository,
          commitSha: params.commitSha,
          path,
        }),
        { method: "HEAD", signal: AbortSignal.timeout(10_000) },
      );
    } catch (error) {
      throw new MarketplaceDiscoveryError(
        `Could not probe ${path}: ${errorMessage(error)}`,
      );
    }
    if (response.status === 404) continue;
    if (!response.ok) {
      throw new MarketplaceDiscoveryError(
        `Could not probe ${path}: GitHub returned ${response.status}`,
      );
    }
    return path;
  }
  return null;
}

function validateMarketplacePath(
  value: string,
): (typeof MARKETPLACE_PATHS)[number] {
  if (!(MARKETPLACE_PATHS as readonly string[]).includes(value)) {
    throw new MarketplaceDiscoveryError(
      "marketplacePath must be a supported marketplace manifest path",
    );
  }
  return value as (typeof MARKETPLACE_PATHS)[number];
}

async function fetchManifest(params: {
  repository: RepositoryLocation;
  commitSha: string;
  marketplacePath: string;
  githubToken?: string;
}): Promise<string | null> {
  const path = params.marketplacePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  let response: Response;
  try {
    response = await fetch(
      rawGithubUrl({
        repository: params.repository,
        commitSha: params.commitSha,
        path,
      }),
      {
        headers: params.githubToken
          ? { Authorization: `Bearer ${params.githubToken}` }
          : undefined,
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    throw new MarketplaceDiscoveryError(
      `Could not fetch ${params.marketplacePath}: ${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    throw new MarketplaceDiscoveryError(
      `Could not fetch ${params.marketplacePath}: GitHub returned ${response.status}`,
    );
  }
  const bytes = await readResponseBodyWithLimit(
    response,
    MAX_MARKETPLACE_BYTES,
  );
  if (!bytes) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function marketplaceEntries(manifest: unknown): unknown[] | null {
  if (Array.isArray(manifest)) return manifest;
  if (!isRecord(manifest)) return null;
  if (Array.isArray(manifest.plugins)) return manifest.plugins;
  if (
    isRecord(manifest.marketplace) &&
    Array.isArray(manifest.marketplace.plugins)
  ) {
    return manifest.marketplace.plugins;
  }
  if (Array.isArray(manifest.extensions)) return manifest.extensions;
  return null;
}

function inferClientType(params: {
  marketplacePath: string;
  manifest: unknown;
}): ClientType | null {
  const byPath: Record<string, ClientType | null> = {
    ".claude-plugin/marketplace.json": "claude-code",
    ".github/plugin/marketplace.json": "copilot-cli",
    ".agents/plugins/marketplace.json": "codex",
    ".cursor-plugin/marketplace.json": "cursor",
    "marketplace.json": null,
  };
  const explicit = isRecord(params.manifest)
    ? (stringValue(params.manifest.clientType) ??
      stringValue(params.manifest.client))
    : null;
  return (
    clientTypeFromValue(explicit) ?? byPath[params.marketplacePath] ?? null
  );
}

async function attachFileCounts(params: {
  entries: PluginMarketplaceDiscoveryEntry[];
  githubToken?: string;
  deadlineAt: number;
  signal?: AbortSignal;
}): Promise<PluginMarketplaceDiscoveryEntry[]> {
  const sources = new Map<
    string,
    { repository: RepositoryLocation; commitSha: string }
  >();
  const sourcesOverBudget = new Set<string>();
  for (const entry of params.entries) {
    if (!entry.supported || !entry.sourceRepoUrl || !entry.sourceCommitSha) {
      continue;
    }
    const repository = parseRepositoryUrl(entry.sourceRepoUrl);
    const key = `${repository.slug}@${entry.sourceCommitSha}`;
    if (!sources.has(key) && sources.size >= MAX_MARKETPLACE_SOURCE_TREES) {
      sourcesOverBudget.add(key);
      continue;
    }
    sources.set(key, { repository, commitSha: entry.sourceCommitSha });
  }
  const loadedTrees = await mapWithConcurrency(
    [...sources.entries()],
    4,
    async ([key, source]) => {
      try {
        const tree = await runWithDeadline({
          deadlineAt: params.deadlineAt,
          message: "Marketplace repository inspection timed out",
          operation: () =>
            githubRepositoryTreeService.read({
              owner: source.repository.owner,
              repo: source.repository.repo,
              commitSha: source.commitSha,
              githubToken: params.githubToken,
              signal: params.signal,
            }),
        });
        return [key, { tree, error: null }] as const;
      } catch (error) {
        return [key, { tree: null, error: errorMessage(error) }] as const;
      }
    },
  );
  const trees = new Map<
    string,
    { tree: GithubTreeItem[] | null; error: string | null }
  >(loadedTrees);

  let remainingSizeProbes = MAX_MARKETPLACE_SIZE_PROBES;
  const enriched = await mapWithConcurrency(
    params.entries,
    8,
    async (entry) => {
      if (!entry.supported || !entry.sourceRepoUrl || !entry.sourceCommitSha) {
        return entry;
      }
      const repository = parseRepositoryUrl(entry.sourceRepoUrl);
      const sourceKey = `${repository.slug}@${entry.sourceCommitSha}`;
      if (sourcesOverBudget.has(sourceKey)) {
        // The marketplace already pinned this source to an immutable commit.
        // Defer expensive tree inspection until the user previews/imports the
        // entry; importPluginFromGithub applies the same path and byte limits.
        return entry;
      }
      const loaded = trees.get(sourceKey);
      if (!loaded?.tree) {
        return {
          ...entry,
          supported: false,
          reason: `Could not inspect plugin files: ${loaded?.error ?? "repository tree unavailable"}`,
        };
      }
      let inspectedTree = loaded.tree;
      let collected = collectPluginTreeFiles({
        tree: inspectedTree,
        subdir: entry.sourceSubdir,
      });
      try {
        while (true) {
          if (collected.unsafePath) {
            return {
              ...entry,
              supported: false,
              reason: `Repository contains unsafe plugin path: ${collected.unsafePath}`,
            };
          }
          const unknownSizes = collected.candidates.filter(
            (candidate) => !candidate.sizeKnown,
          );
          if (unknownSizes.length === 0) break;
          if (unknownSizes.length > remainingSizeProbes) {
            return {
              ...entry,
              fileCount: collected.candidates.length,
              supported: false,
              reason: "Marketplace file-size inspection budget was exhausted",
            };
          }
          remainingSizeProbes -= unknownSizes.length;
          const sizes = await mapWithConcurrency(
            unknownSizes,
            10,
            async (candidate) =>
              [
                candidate.repoPath,
                await fetchRawFileSize({
                  repository,
                  commitSha: entry.sourceCommitSha as string,
                  path: candidate.repoPath,
                  githubToken: params.githubToken,
                  deadlineAt: params.deadlineAt,
                  signal: params.signal,
                }),
              ] as const,
          );
          const sizesByPath = new Map(sizes);
          inspectedTree = inspectedTree.map((item) =>
            item.path && sizesByPath.has(item.path)
              ? { ...item, size: sizesByPath.get(item.path) }
              : item,
          );
          loaded.tree = inspectedTree;
          collected = collectPluginTreeFiles({
            tree: inspectedTree,
            subdir: entry.sourceSubdir,
          });
        }
      } catch (error) {
        return {
          ...entry,
          fileCount: collected.candidates.length,
          supported: false,
          reason: `Could not inspect plugin file sizes: ${errorMessage(error)}`,
        };
      }
      if (collected.candidates.length > 0) {
        return { ...entry, fileCount: collected.candidates.length };
      }
      return {
        ...entry,
        fileCount: 0,
        supported: false,
        reason:
          collected.skippedFiles.length > 0
            ? "Source plugin files exceed the safe payload limits or are excluded"
            : "Source does not contain importable plugin files",
      };
    },
  );
  return enriched;
}

async function normalizeEntry(params: {
  plugin: unknown;
  marketplacePath: string;
  clientType: ClientType | null;
  repository: RepositoryLocation;
  ref: string | null;
  commitSha: string;
  resolveCommit: (
    repository: RepositoryLocation,
    ref: string | null,
  ) => Promise<string>;
}): Promise<{
  marketplacePath: string;
  name: string;
  description: string;
  version: string;
  clientType: ClientType | null;
  sourceRepoUrl: string | null;
  sourceRef: string | null;
  sourceSubdir: string;
  sourceCommitSha: string | null;
  fileCount: number;
  supported: boolean;
  reason: string | null;
}> {
  const entry = isRecord(params.plugin) ? params.plugin : {};
  const name = stringValue(entry.name) ?? "";
  const description =
    stringValue(entry.description) ?? stringValue(entry.summary) ?? "";
  const version = stringValue(entry.version) ?? "";
  const clientType =
    clientTypeFromValue(
      stringValue(entry.clientType) ?? stringValue(entry.client),
    ) ?? params.clientType;
  const base = {
    marketplacePath: params.marketplacePath,
    name,
    description,
    version,
    clientType,
  };

  if (!isRecord(params.plugin)) {
    return unsupportedEntry(base, "Plugin entry must be an object");
  }
  if (!name) return unsupportedEntry(base, "Plugin entry must include a name");
  if (!clientType) {
    return unsupportedEntry(base, "Could not infer a supported client type");
  }

  const source = parsePluginSource(entry.source ?? entry.path);
  if (source.kind === "invalid") return unsupportedEntry(base, source.reason);
  if (source.kind === "local") {
    return {
      ...base,
      sourceRepoUrl: params.repository.slug,
      sourceRef: params.ref,
      sourceSubdir: source.path,
      sourceCommitSha: params.commitSha,
      fileCount: 0,
      supported: true,
      reason: null,
    };
  }

  try {
    const sourceCommitSha =
      source.commitSha ??
      (await params.resolveCommit(source.repository, source.ref));
    return {
      ...base,
      sourceRepoUrl: source.repository.slug,
      sourceRef: source.ref,
      sourceSubdir: source.path,
      sourceCommitSha,
      fileCount: 0,
      supported: true,
      reason: null,
    };
  } catch (error) {
    return unsupportedEntry(
      base,
      `Could not resolve external source: ${errorMessage(error)}`,
      {
        sourceRepoUrl: source.repository.slug,
        sourceRef: source.ref,
        sourceSubdir: source.path,
      },
    );
  }
}

function unsupportedEntry(
  base: {
    marketplacePath: string;
    name: string;
    description: string;
    version: string;
    clientType: ClientType | null;
  },
  reason: string,
  source: {
    sourceRepoUrl?: string | null;
    sourceRef?: string | null;
    sourceSubdir?: string;
  } = {},
) {
  return {
    ...base,
    sourceRepoUrl: source.sourceRepoUrl ?? null,
    sourceRef: source.sourceRef ?? null,
    sourceSubdir: source.sourceSubdir ?? "",
    sourceCommitSha: null,
    fileCount: 0,
    supported: false,
    reason,
  };
}

type PluginSource =
  | { kind: "local"; path: string }
  | {
      kind: "github";
      repository: RepositoryLocation;
      ref: string | null;
      commitSha: string | null;
      path: string;
    }
  | { kind: "invalid"; reason: string };

function parsePluginSource(value: unknown): PluginSource {
  if (typeof value === "string") {
    if (
      value.startsWith("https://github.com/") ||
      value.startsWith("http://github.com/")
    ) {
      return githubSourceFromUrl(value);
    }
    const path = normalizeLocalPath(value);
    return path === null
      ? {
          kind: "invalid",
          reason: "Plugin source must be a safe relative path or GitHub URL",
        }
      : { kind: "local", path };
  }
  if (!isRecord(value)) {
    return { kind: "invalid", reason: "Plugin entry must include a source" };
  }

  const sourceType = stringValue(value.source);
  if (sourceType === "local") {
    const path = normalizeLocalPath(stringValue(value.path) ?? "");
    return path === null
      ? { kind: "invalid", reason: "Local plugin source path must be safe" }
      : { kind: "local", path };
  }
  if (sourceType === "github" || typeof value.repo === "string") {
    return githubSourceFromParts({
      repo: stringValue(value.repo),
      ref: stringValue(value.ref),
      commitSha: stringValue(value.sha),
      path: stringValue(value.path),
    });
  }
  if (typeof value.url === "string") {
    const source = githubSourceFromUrl(value.url);
    if (source.kind !== "github") return source;
    const path = normalizeLocalPath(stringValue(value.path) ?? source.path);
    if (path === null) {
      return {
        kind: "invalid",
        reason: "GitHub plugin source path must be safe",
      };
    }
    const commitSha = stringValue(value.sha);
    if (commitSha && !isCommitSha(commitSha)) {
      return {
        kind: "invalid",
        reason: "GitHub plugin source SHA must be a 40-character commit",
      };
    }
    return {
      ...source,
      ref: stringValue(value.ref) ?? source.ref,
      commitSha,
      path,
    };
  }
  return { kind: "invalid", reason: "Unsupported plugin source" };
}

function githubSourceFromParts(params: {
  repo: string | null;
  ref: string | null;
  commitSha?: string | null;
  path: string | null;
}): PluginSource {
  if (!params.repo) {
    return {
      kind: "invalid",
      reason: "GitHub plugin source must include a repository",
    };
  }
  let repository: RepositoryLocation;
  try {
    repository = parseRepositoryUrl(params.repo);
  } catch {
    return {
      kind: "invalid",
      reason: "GitHub plugin source repository is invalid",
    };
  }
  const path = normalizeLocalPath(params.path ?? "");
  if (path === null) {
    return {
      kind: "invalid",
      reason: "GitHub plugin source path must be safe",
    };
  }
  if (params.commitSha && !isCommitSha(params.commitSha)) {
    return {
      kind: "invalid",
      reason: "GitHub plugin source SHA must be a 40-character commit",
    };
  }
  return {
    kind: "github",
    repository,
    ref: params.ref ?? repository.ref,
    commitSha: params.commitSha ?? null,
    path,
  };
}

function githubSourceFromUrl(value: string): PluginSource {
  let repository: RepositoryLocation;
  try {
    repository = parseRepositoryUrl(value);
  } catch {
    return { kind: "invalid", reason: "GitHub plugin source URL is invalid" };
  }
  const segments = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  const path = segments[2] === "tree" ? segments.slice(4).join("/") : "";
  const normalizedPath = normalizeLocalPath(path);
  if (normalizedPath === null) {
    return {
      kind: "invalid",
      reason: "GitHub plugin source path must be safe",
    };
  }
  return {
    kind: "github",
    repository,
    ref: repository.ref,
    commitSha: null,
    path: normalizedPath,
  };
}

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function normalizeLocalPath(value: string): string | null {
  const normalized = value.trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (
    normalized.startsWith("/") ||
    normalized.includes("//") ||
    normalized.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalized) ||
    normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }
  return normalized;
}

function clientTypeFromValue(value: string | null): ClientType | null {
  switch (value?.trim().toLowerCase()) {
    case "claude":
    case "claude-code":
      return "claude-code";
    case "copilot":
    case "copilot-cli":
    case "github-copilot":
      return "copilot-cli";
    case "codex":
    case "codex-cli":
      return "codex";
    case "cursor":
      return "cursor";
    default:
      return null;
  }
}

function rawGithubUrl(params: {
  repository: RepositoryLocation;
  commitSha: string;
  path: string;
}): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(params.repository.owner)}/${encodeURIComponent(params.repository.repo)}/${params.commitSha}/${params.path}`;
}

async function fetchRawFileSize(params: {
  repository: RepositoryLocation;
  commitSha: string;
  path: string;
  githubToken?: string;
  deadlineAt: number;
  signal?: AbortSignal;
}): Promise<number> {
  const encodedPath = params.path.split("/").map(encodeURIComponent).join("/");
  const remainingMs = params.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Marketplace file-size inspection timed out");
  }
  const response = await fetch(
    rawGithubUrl({
      repository: params.repository,
      commitSha: params.commitSha,
      path: encodedPath,
    }),
    {
      method: "HEAD",
      headers: params.githubToken
        ? { Authorization: `Bearer ${params.githubToken}` }
        : undefined,
      signal: params.signal
        ? AbortSignal.any([
            params.signal,
            AbortSignal.timeout(Math.min(10_000, remainingMs)),
          ])
        : AbortSignal.timeout(Math.min(10_000, remainingMs)),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${params.path}`);
  }
  const size = Number(response.headers.get("content-length"));
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`GitHub omitted Content-Length for ${params.path}`);
  }
  return size;
}

async function runWithDeadline<Value>(params: {
  deadlineAt: number;
  message: string;
  operation: () => Promise<Value>;
}): Promise<Value> {
  const remainingMs = params.deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error(params.message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      params.operation(),
      new Promise<Value>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(params.message)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () =>
      worker(),
    ),
  );
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
