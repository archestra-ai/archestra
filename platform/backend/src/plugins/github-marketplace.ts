import {
  GIT_PROVIDER_LABELS,
  type GitHost,
  gitHostFromUrl,
  PLUGIN_MARKETPLACE_DISCOVERY_LIMIT,
} from "@archestra/shared";
import type { GitAccess } from "@/git-hosts/git-access";
import type {
  ClientType,
  PluginMarketplaceDiscovery,
  PluginMarketplaceDiscoveryEntry,
} from "@/types";
import type { GithubTreeItem } from "./github-tree";
import {
  createPluginRepoReader,
  isGithubCloud,
  type PluginRepoReader,
  parsePluginRepoUrl,
} from "./plugin-repo-reader";
import { collectPluginTreeFiles } from "./plugin-tree-files";

const MARKETPLACE_PATHS = [
  ".claude-plugin/marketplace.json",
  ".github/plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "marketplace.json",
] as const;

const MAX_MARKETPLACE_BYTES = 1024 * 1024;
const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
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
 *
 * Works on GitHub and GitLab, cloud or self-hosted. A repository without a
 * marketplace manifest is scanned for plugin folders instead: every folder
 * holding a `plugin.json` (or `.claude-plugin/plugin.json`) becomes an entry,
 * and the result reports `marketplacePath: null`.
 */
export async function discoverGithubMarketplace(params: {
  repoUrl: string;
  ref?: string | null;
  marketplacePath?: string;
  /** Host and token; omitted means public github.com. */
  access?: GitAccess;
}): Promise<PluginMarketplaceDiscovery> {
  const deadlineAt = Date.now() + MARKETPLACE_DISCOVERY_DEADLINE_MS;
  const deadlineSignal = AbortSignal.timeout(MARKETPLACE_DISCOVERY_DEADLINE_MS);
  const readers = new MarketplaceReaders(params.access);
  const reader = readers.main;
  const repository = parseRepositoryUrl({
    value: params.repoUrl,
    host: reader.host,
  });
  const ref = repository.ref ?? params.ref ?? null;
  const pendingCommits = new Map<string, Promise<string>>();
  const externalCommitKeys = new Set<string>();
  const marketplaceCommitKey = commitKey(repository, ref);
  const resolveRepositoryCommit = async (
    target: RepositoryLocation,
    targetRef: string | null,
  ): Promise<string> => {
    const key = commitKey(target, targetRef);
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
    const resolution = readers
      .for(target.host)
      .resolveCommit({
        repo: target.path,
        ref: targetRef,
        signal: deadlineSignal,
      })
      .catch((error) => {
        throw new MarketplaceDiscoveryError(errorMessage(error));
      })
      .finally(() => pendingCommits.delete(key));
    pendingCommits.set(key, resolution);
    return resolution;
  };

  const commitSha = await resolveRepositoryCommit(repository, ref);
  const marketplacePath = await reader
    .findFirstFile({
      repo: repository.path,
      commitSha,
      paths: params.marketplacePath
        ? [validateMarketplacePath(params.marketplacePath)]
        : MARKETPLACE_PATHS,
    })
    .catch((error) => {
      throw new MarketplaceDiscoveryError(errorMessage(error));
    });

  if (!marketplacePath) {
    if (params.marketplacePath) {
      return {
        repoUrl: repository.path,
        ref,
        commitSha,
        marketplacePath: null,
        entries: [],
        reason: "No supported marketplace manifest was found",
      };
    }
    const folders = await discoverPluginFolders({
      reader,
      repository,
      ref,
      commitSha,
      signal: deadlineSignal,
    });
    if (folders.length === 0) {
      return {
        repoUrl: repository.path,
        ref,
        commitSha,
        marketplacePath: null,
        entries: [],
        reason:
          "No supported marketplace manifest or plugin folder (plugin.json) was found",
      };
    }
    const entries = await attachFileCounts({
      entries: markDuplicateNames(folders),
      readers,
      deadlineAt,
      signal: deadlineSignal,
    });
    return {
      repoUrl: repository.path,
      ref,
      commitSha,
      marketplacePath: null,
      entries,
      reason: null,
    };
  }

  const raw = await fetchManifest({
    reader,
    repository,
    commitSha,
    marketplacePath,
  });
  if (raw === null) {
    return {
      repoUrl: repository.path,
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
      repoUrl: repository.path,
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
      repoUrl: repository.path,
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
  const entries = await attachFileCounts({
    entries: markDuplicateNames(normalized),
    readers,
    deadlineAt,
    signal: deadlineSignal,
  });

  return {
    repoUrl: repository.path,
    ref,
    commitSha,
    marketplacePath,
    entries,
    reason: null,
  };
}

/**
 * The repository and access an advertised entry is read with. Entries on the
 * marketplace's host carry a bare repository path and use its access; a
 * github.com source advertised by a marketplace elsewhere carries a full
 * github.com URL and is read publicly, so a credential never leaves its host.
 */
export function marketplaceSourceAccess(params: {
  sourceRepoUrl: string;
  access?: GitAccess;
}): { repoUrl: string; access?: GitAccess } {
  if (
    params.access &&
    !isGithubCloud(params.access.host) &&
    hasScheme(params.sourceRepoUrl) &&
    new URL(params.sourceRepoUrl).host === GITHUB_CLOUD.host
  ) {
    return { repoUrl: params.sourceRepoUrl };
  }
  return { repoUrl: params.sourceRepoUrl, access: params.access };
}

// === Internal helpers ===

interface RepositoryLocation {
  host: GitHost;
  /** `owner/repo`, or a nested GitLab `group/sub/project`. */
  path: string;
  ref: string | null;
}

const GITHUB_CLOUD = (() => {
  const host = gitHostFromUrl({ provider: "github" });
  return { gitHost: host, host: new URL(host.webUrl).host };
})();

/**
 * The marketplace host's reader (with the caller's token) plus a public
 * github.com reader for github.com sources advertised from another host.
 */
class MarketplaceReaders {
  readonly main: PluginRepoReader;
  private publicGithub: PluginRepoReader | null = null;

  constructor(access: GitAccess | undefined) {
    this.main = createPluginRepoReader(access);
  }

  for(host: GitHost): PluginRepoReader {
    if (host.webUrl === this.main.host.webUrl) return this.main;
    this.publicGithub ??= createPluginRepoReader();
    return this.publicGithub;
  }
}

function parseRepositoryUrl(params: {
  value: string;
  host: GitHost;
}): RepositoryLocation {
  try {
    const location = parsePluginRepoUrl({
      repoUrl: params.value,
      host: params.host,
    });
    return { host: params.host, path: location.path, ref: location.ref };
  } catch (error) {
    throw new MarketplaceDiscoveryError(errorMessage(error));
  }
}

/** The location behind an entry's `sourceRepoUrl` (see `marketplaceSourceAccess`). */
function sourceLocation(params: {
  sourceRepoUrl: string;
  mainHost: GitHost;
}): RepositoryLocation {
  const host =
    hasScheme(params.sourceRepoUrl) &&
    new URL(params.sourceRepoUrl).host === GITHUB_CLOUD.host
      ? GITHUB_CLOUD.gitHost
      : params.mainHost;
  return parseRepositoryUrl({ value: params.sourceRepoUrl, host });
}

/** How an entry names its repository: a path on the marketplace's host, else a full URL. */
function sourceRepoUrlFor(params: {
  location: RepositoryLocation;
  mainHost: GitHost;
}): string {
  return params.location.host.webUrl === params.mainHost.webUrl
    ? params.location.path
    : `${params.location.host.webUrl}/${params.location.path}`;
}

function commitKey(location: RepositoryLocation, ref: string | null): string {
  return `${location.host.webUrl}|${location.path}@${ref ?? "HEAD"}`;
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value.trim());
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
  reader: PluginRepoReader;
  repository: RepositoryLocation;
  commitSha: string;
  marketplacePath: string;
}): Promise<string | null> {
  let bytes: Buffer | null;
  try {
    bytes = await params.reader.readFile({
      repo: params.repository.path,
      commitSha: params.commitSha,
      path: params.marketplacePath,
      maxBytes: MAX_MARKETPLACE_BYTES,
      timeoutMs: 10_000,
    });
  } catch (error) {
    throw new MarketplaceDiscoveryError(
      `Could not fetch ${params.marketplacePath}: ${errorMessage(error)}`,
    );
  }
  return bytes ? decodeUtf8(bytes) : null;
}

/**
 * Plugin folders in a repository without a marketplace manifest: every folder
 * holding `plugin.json` or `.claude-plugin/plugin.json`. Each behaves like a
 * relative-path marketplace entry pinned to the repository's commit.
 */
async function discoverPluginFolders(params: {
  reader: PluginRepoReader;
  repository: RepositoryLocation;
  ref: string | null;
  commitSha: string;
  signal?: AbortSignal;
}): Promise<MarketplaceEntry[]> {
  let tree: GithubTreeItem[];
  try {
    tree = await params.reader.readTree({
      repo: params.repository.path,
      commitSha: params.commitSha,
      signal: params.signal,
    });
  } catch (error) {
    throw new MarketplaceDiscoveryError(
      `Could not read repository tree: ${errorMessage(error)}`,
    );
  }
  const manifests = new Map<string, string>();
  for (const item of tree) {
    if (item.type !== "blob" || !item.path) continue;
    const folder = pluginFolderOf(item.path);
    if (folder === null) continue;
    // `.claude-plugin/plugin.json` wins over a sibling `plugin.json`.
    if (!manifests.has(folder) || item.path.includes(".claude-plugin/")) {
      manifests.set(folder, item.path);
    }
  }
  if (manifests.size > PLUGIN_MARKETPLACE_DISCOVERY_LIMIT) {
    throw new MarketplaceDiscoveryError(
      `Repository has ${manifests.size} plugin folders; the discovery limit is ${PLUGIN_MARKETPLACE_DISCOVERY_LIMIT}`,
    );
  }
  const folders = [...manifests.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return mapWithConcurrency(
    folders,
    MARKETPLACE_RESOLVE_CONCURRENCY,
    async ([folder, manifestPath]) => {
      const manifest = await readPluginManifest({
        reader: params.reader,
        repository: params.repository,
        commitSha: params.commitSha,
        path: manifestPath,
      });
      const fallbackName =
        (folder || params.repository.path).split("/").pop() ?? "";
      return {
        marketplacePath: manifestPath,
        name: stringValue(manifest?.name)?.trim() || fallbackName,
        description: stringValue(manifest?.description) ?? "",
        version: stringValue(manifest?.version) ?? "",
        clientType:
          clientTypeFromValue(
            stringValue(manifest?.clientType) ?? stringValue(manifest?.client),
          ) ?? "claude-code",
        sourceRepoUrl: params.repository.path,
        sourceRef: params.ref,
        sourceSubdir: folder,
        sourceCommitSha: params.commitSha,
        fileCount: 0,
        supported: true,
        reason: null,
      };
    },
  );
}

/**
 * The plugin folder a `plugin.json` path declares, or null. Hidden folders
 * (other than `.claude-plugin`) and dependency folders are skipped.
 */
function pluginFolderOf(path: string): string | null {
  const segments = path.split("/");
  if (segments.pop() !== "plugin.json") return null;
  if (segments.at(-1) === ".claude-plugin") segments.pop();
  if (
    segments.some(
      (segment) => segment.startsWith(".") || segment === "node_modules",
    )
  ) {
    return null;
  }
  const folder = segments.join("/");
  return normalizeLocalPath(folder) === folder ? folder : null;
}

async function readPluginManifest(params: {
  reader: PluginRepoReader;
  repository: RepositoryLocation;
  commitSha: string;
  path: string;
}): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await params.reader.readFile({
      repo: params.repository.path,
      commitSha: params.commitSha,
      path: params.path,
      maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
      timeoutMs: 10_000,
    });
    const text = bytes ? decodeUtf8(bytes) : null;
    const parsed: unknown = text ? JSON.parse(text) : null;
    return isRecord(parsed) ? parsed : null;
  } catch {
    // An unreadable manifest still names its folder.
    return null;
  }
}

function markDuplicateNames(entries: MarketplaceEntry[]): MarketplaceEntry[] {
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.name)
      nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  return entries.map((entry) =>
    entry.name && (nameCounts.get(entry.name) ?? 0) > 1
      ? {
          ...entry,
          supported: false,
          reason: `Marketplace contains duplicate plugin name "${entry.name}"`,
        }
      : entry,
  );
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

type MarketplaceEntry = PluginMarketplaceDiscoveryEntry;

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
  readers: MarketplaceReaders;
  deadlineAt: number;
  signal?: AbortSignal;
}): Promise<PluginMarketplaceDiscoveryEntry[]> {
  const mainHost = params.readers.main.host;
  const sources = new Map<
    string,
    { repository: RepositoryLocation; commitSha: string }
  >();
  const sourcesOverBudget = new Set<string>();
  for (const entry of params.entries) {
    if (!entry.supported || !entry.sourceRepoUrl || !entry.sourceCommitSha) {
      continue;
    }
    const repository = sourceLocation({
      sourceRepoUrl: entry.sourceRepoUrl,
      mainHost,
    });
    const key = commitKey(repository, entry.sourceCommitSha);
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
            params.readers.for(source.repository.host).readTree({
              repo: source.repository.path,
              commitSha: source.commitSha,
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
      const repository = sourceLocation({
        sourceRepoUrl: entry.sourceRepoUrl,
        mainHost,
      });
      const sourceKey = commitKey(repository, entry.sourceCommitSha);
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
                await fetchFileSize({
                  reader: params.readers.for(repository.host),
                  repository,
                  commitSha: entry.sourceCommitSha as string,
                  path: candidate.repoPath,
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

  const mainHost = params.repository.host;
  const source = parsePluginSource({
    value: entry.source ?? entry.path,
    host: mainHost,
  });
  if (source.kind === "invalid") return unsupportedEntry(base, source.reason);
  if (source.kind === "local") {
    return {
      ...base,
      sourceRepoUrl: params.repository.path,
      sourceRef: params.ref,
      sourceSubdir: source.path,
      sourceCommitSha: params.commitSha,
      fileCount: 0,
      supported: true,
      reason: null,
    };
  }

  const sourceRepoUrl = sourceRepoUrlFor({
    location: source.repository,
    mainHost,
  });
  try {
    const sourceCommitSha =
      source.commitSha ??
      (await params.resolveCommit(source.repository, source.ref));
    return {
      ...base,
      sourceRepoUrl,
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
        sourceRepoUrl,
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
      kind: "remote";
      repository: RepositoryLocation;
      ref: string | null;
      commitSha: string | null;
      path: string;
    }
  | { kind: "invalid"; reason: string };

/**
 * A marketplace entry's source: a relative path in the marketplace's
 * repository, a URL on the marketplace's host (GitHub `/tree/<ref>/<path>` or
 * GitLab `/-/tree/<ref>/<path>` forms), or a `{ source: "github", repo }`
 * object, which always means github.com.
 */
function parsePluginSource(params: {
  value: unknown;
  host: GitHost;
}): PluginSource {
  const { value, host } = params;
  const label = GIT_PROVIDER_LABELS[host.provider];
  if (typeof value === "string") {
    if (hasScheme(value)) return sourceFromUrl({ value, host });
    const path = normalizeLocalPath(value);
    return path === null
      ? {
          kind: "invalid",
          reason: `Plugin source must be a safe relative path or ${label} URL`,
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
    const source = sourceFromUrl({ value: value.url, host });
    if (source.kind !== "remote") return source;
    const path = normalizeLocalPath(stringValue(value.path) ?? source.path);
    if (path === null) {
      return {
        kind: "invalid",
        reason: `${label} plugin source path must be safe`,
      };
    }
    const commitSha = stringValue(value.sha);
    if (commitSha && !isCommitSha(commitSha)) {
      return {
        kind: "invalid",
        reason: `${label} plugin source SHA must be a 40-character commit`,
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

/** `{ source: "github", repo }` entries name github.com repositories. */
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
    repository = parseRepositoryUrl({
      value: params.repo,
      host: GITHUB_CLOUD.gitHost,
    });
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
    kind: "remote",
    repository,
    ref: params.ref ?? repository.ref,
    commitSha: params.commitSha ?? null,
    path,
  };
}

/** A repository URL on the marketplace's own host. */
function sourceFromUrl(params: { value: string; host: GitHost }): PluginSource {
  const label = GIT_PROVIDER_LABELS[params.host.provider];
  let location: ReturnType<typeof parsePluginRepoUrl>;
  try {
    location = parsePluginRepoUrl({
      repoUrl: params.value,
      host: params.host,
    });
  } catch {
    return {
      kind: "invalid",
      reason: `${label} plugin source URL is invalid or not on ${params.host.webUrl}`,
    };
  }
  const normalizedPath = normalizeLocalPath(location.subpath);
  if (normalizedPath === null) {
    return {
      kind: "invalid",
      reason: `${label} plugin source path must be safe`,
    };
  }
  return {
    kind: "remote",
    repository: { host: params.host, path: location.path, ref: location.ref },
    ref: location.ref,
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
    case "claude-desktop":
    case "cowork":
      return "claude-desktop";
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

async function fetchFileSize(params: {
  reader: PluginRepoReader;
  repository: RepositoryLocation;
  commitSha: string;
  path: string;
  deadlineAt: number;
  signal?: AbortSignal;
}): Promise<number> {
  const remainingMs = params.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Marketplace file-size inspection timed out");
  }
  return params.reader.fileSize({
    repo: params.repository.path,
    commitSha: params.commitSha,
    path: params.path,
    timeoutMs: Math.min(10_000, remainingMs),
    signal: params.signal,
  });
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
