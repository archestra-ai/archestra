import {
  type GitHost,
  type GitProvider,
  gitHostFromUrl,
  isCloudGitHost,
  normalizeGitSubpath,
  parseGitRepoUrl,
  TimeInMs,
} from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import type { GitAccess } from "@/git-hosts/git-access";
import { GitHostClient } from "@/git-hosts/git-host-client";
import logger from "@/logging";
import type { SkillFileEncoding, SkillFileKind } from "@/types";
import {
  deriveSkillFileKind,
  type ParsedSkill,
  parseSkillManifest,
  SKILL_MANIFEST_FILENAME,
} from "./parser";

/**
 * Imports Agent Skills from GitHub or GitLab repositories, cloud or
 * self-hosted. A skill is any directory containing a `SKILL.md` file, at any
 * depth.
 *
 * Per-repo tree state from `discoverSkills` is cached briefly and reused by
 * `importSkills` so a discover → import round-trip from the UI doesn't pay the
 * REST quota cost twice.
 */

/**
 * Per-file size cap. Generous enough to import binary assets (images, fonts,
 * small PDFs) so we can faithfully redistribute whole skills.
 */
export const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024;
/**
 * Character cap for a single stored file's `content`. A binary file at the
 * `MAX_SKILL_FILE_BYTES` limit grows ~33% once base64-encoded, so the text
 * cap has to leave room for that expansion.
 */
export const MAX_SKILL_FILE_CONTENT_CHARS =
  Math.ceil(MAX_SKILL_FILE_BYTES / 3) * 4;
/** Cap on resource files copied per skill. */
export const MAX_FILES_PER_SKILL = 500;
/**
 * How many file fetches run at once when discovering or
 * importing a whole library. Conservative: enough to turn a serial whole-repo
 * import from minutes into seconds, low enough to stay well under raw-content
 * rate limits without any retry. Lower this if 429s ever appear in practice.
 */
const SKILL_IMPORT_FETCH_CONCURRENCY = 8;
/** Number of distinct repo snapshots to keep cached across requests. */
const REPO_CACHE_MAX_ENTRIES = 50;
/**
 * How long a repo snapshot stays cached. Short enough that an import sees the
 * same commit the user discovered, long enough to cover a typical
 * discover-then-import flow without re-fetching.
 */
const REPO_CACHE_TTL_MS = 5 * TimeInMs.Minute;

/** Raised when a repository URL is malformed or content cannot be fetched. */
export class SkillImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillImportError";
  }
}

/** A skill directory found while walking a repository tree. */
interface DiscoveredSkill {
  /** Directory path of the skill, relative to the repo root. */
  skillPath: string;
  name: string;
  description: string;
  compatibility: string | null;
  allowedTools: string | null;
  templated: boolean;
  /** Total files the skill ships, including its own SKILL.md. */
  fileCount: number;
}

/** A fully fetched skill ready to be persisted. */
interface ImportedSkill {
  /** Directory path of the skill, relative to the repo root. */
  skillPath: string;
  parsed: ParsedSkill;
  files: {
    path: string;
    content: string;
    encoding: SkillFileEncoding;
    kind: SkillFileKind;
  }[];
  /**
   * Resource paths (relative to the skill dir) that were not imported:
   * oversized files, files beyond the per-skill cap, and files whose fetch
   * failed. Surfaced to the caller so drops are never silent.
   */
  skippedFiles: string[];
  /** Provenance string, e.g. `owner/repo@main:skills/pdf`. */
  sourceRef: string;
  sourceProvider: GitProvider;
  /** Repository web origin; null means the provider's cloud. */
  sourceOrigin: string | null;
  /** Commit SHA the snapshot was taken at. */
  sourceCommit: string;
  /**
   * The ref the caller asked for (branch/tag from the URL), or null when the
   * repo's default branch (HEAD) was used. Unlike `sourceRef` this never pins
   * a resolved SHA, so it is the tracking target for a recurring sync.
   */
  requestedRef: string | null;
}

interface RepoLocation {
  host: GitHost;
  /** `owner/repo`, or a nested GitLab `group/sub/project`. */
  path: string;
  ref: string | null;
  subpath: string;
}

interface TreeItem {
  type?: string;
  path?: string;
  size?: number;
}

/** Snapshot of a repo at a specific commit, shared between discover and import. */
interface CachedRepo {
  commitSha: string;
  tree: TreeItem[];
  /** Manifests parsed during discovery, keyed by their full repo path. */
  manifests: Map<string, ParsedSkill>;
}

/**
 * Walk a repository tree and return every directory containing a `SKILL.md`,
 * with the skill's catalog metadata parsed from its frontmatter.
 */
export async function discoverSkills(params: {
  repoUrl: string;
  path?: string;
  /** Host and token; omitted means public github.com. */
  access?: GitAccess;
}): Promise<{ repoUrl: string; ref: string; skills: DiscoveredSkill[] }> {
  const location = parseRepoUrl(params);
  const client = clientFor(params.access, location);
  const snapshot = await loadRepoSnapshot(client, location);

  const manifestPaths = snapshot.tree
    .filter(
      (item) =>
        item.type === "blob" &&
        !!item.path &&
        basename(item.path) === SKILL_MANIFEST_FILENAME &&
        isUnderSubpath(item.path, location.subpath),
    )
    .map((item) => item.path as string);

  // Fetch every uncached manifest concurrently; an already-cached manifest
  // (e.g. from an earlier discover within the snapshot TTL) skips the fetch.
  const fetchedManifests = await mapWithConcurrency({
    items: manifestPaths,
    limit: SKILL_IMPORT_FETCH_CONCURRENCY,
    fn: (manifestPath) =>
      snapshot.manifests.has(manifestPath)
        ? Promise.resolve(null)
        : fetchRawFile(client, location, snapshot.commitSha, manifestPath),
  });

  // Parse + cache + assemble sequentially in tree order so the manifest map is
  // written without a race and the output order is deterministic.
  const skills: DiscoveredSkill[] = [];
  for (let i = 0; i < manifestPaths.length; i += 1) {
    const manifestPath = manifestPaths[i];
    const skillPath = dirname(manifestPath);
    let parsed = snapshot.manifests.get(manifestPath);
    if (!parsed) {
      const raw = fetchedManifests[i];
      if (raw === null || raw.encoding !== "utf8") continue;

      try {
        parsed = parseSkillManifest(raw.content);
      } catch (error) {
        logger.warn(
          { manifestPath, error: errorMessage(error) },
          "[Skills] Skipping skill with unparseable SKILL.md",
        );
        continue;
      }
      snapshot.manifests.set(manifestPath, parsed);
    }

    // count every file the skill ships, including its own SKILL.md, so an
    // instruction-only skill reads "1 file" rather than "0".
    const fileCount = snapshot.tree.filter(
      (item) =>
        item.type === "blob" &&
        !!item.path &&
        isUnderSkillDir(item.path, skillPath),
    ).length;

    skills.push({
      skillPath,
      name: parsed.name,
      description: parsed.description,
      compatibility: parsed.compatibility,
      allowedTools: parsed.allowedTools,
      templated: parsed.templated,
      fileCount,
    });
  }

  return {
    repoUrl: location.path,
    ref: location.ref ?? snapshot.commitSha,
    skills,
  };
}

/**
 * Fetch the full contents of the selected skill directories. Binary files are
 * imported base64-encoded (`encoding: "base64"`); text resources stay utf8.
 */
export async function importSkills(params: {
  repoUrl: string;
  path?: string;
  access?: GitAccess;
  skillPaths: string[];
}): Promise<ImportedSkill[]> {
  const location = parseRepoUrl(params);
  const client = clientFor(params.access, location);
  const snapshot = await loadRepoSnapshot(client, location);
  const ref = location.ref ?? snapshot.commitSha;

  // First pass (no resource I/O beyond a rare manifest cache-miss): resolve each
  // skill's manifest and the resource paths to fetch, so the fetches can then run
  // as one concurrent batch across all skills.
  const plans: {
    skillPath: string;
    parsed: ParsedSkill;
    toRelative: (absolutePath: string) => string;
    resourcePaths: string[];
    skippedFiles: string[];
  }[] = [];
  for (const skillPath of params.skillPaths) {
    const manifestPath = skillPath
      ? `${skillPath}/${SKILL_MANIFEST_FILENAME}`
      : SKILL_MANIFEST_FILENAME;
    let parsed = snapshot.manifests.get(manifestPath);
    if (!parsed) {
      const raw = await fetchRawFile(
        client,
        location,
        snapshot.commitSha,
        manifestPath,
      );
      if (raw === null || raw.encoding !== "utf8") {
        throw new SkillImportError(`No SKILL.md found at ${skillPath}`);
      }
      parsed = parseSkillManifest(raw.content);
      snapshot.manifests.set(manifestPath, parsed);
    }

    const toRelative = (absolutePath: string) =>
      skillPath ? absolutePath.slice(skillPath.length + 1) : absolutePath;
    const skippedFiles: string[] = [];

    // Pre-filter using the tree's `size` field so we don't issue HTTP requests
    // for files we'd immediately drop on the response side.
    const candidatePaths: string[] = [];
    for (const item of snapshot.tree) {
      if (
        item.type !== "blob" ||
        !item.path ||
        !isUnderSkillDir(item.path, skillPath) ||
        basename(item.path) === SKILL_MANIFEST_FILENAME
      ) {
        continue;
      }
      if (typeof item.size === "number" && item.size > MAX_SKILL_FILE_BYTES) {
        skippedFiles.push(toRelative(item.path));
        continue;
      }
      candidatePaths.push(item.path);
    }
    const resourcePaths = candidatePaths.slice(0, MAX_FILES_PER_SKILL);
    skippedFiles.push(
      ...candidatePaths.slice(MAX_FILES_PER_SKILL).map(toRelative),
    );

    plans.push({ skillPath, parsed, toRelative, resourcePaths, skippedFiles });
  }

  // Fetch every resource file across all skills concurrently. The flat job list
  // and order-preserving map let each skill reassemble its files in tree order.
  const jobs = plans.flatMap((plan, skillIdx) =>
    plan.resourcePaths.map((absolutePath) => ({ skillIdx, absolutePath })),
  );
  const fetchedFiles = await mapWithConcurrency({
    items: jobs,
    limit: SKILL_IMPORT_FETCH_CONCURRENCY,
    fn: (job) =>
      fetchRawFile(client, location, snapshot.commitSha, job.absolutePath),
  });

  const imported: ImportedSkill[] = [];
  let cursor = 0;
  for (const plan of plans) {
    const files: ImportedSkill["files"] = [];
    for (const absolutePath of plan.resourcePaths) {
      const fetched = fetchedFiles[cursor];
      cursor += 1;
      const relativePath = plan.toRelative(absolutePath);
      if (fetched === null) {
        plan.skippedFiles.push(relativePath);
        continue;
      }
      files.push({
        path: relativePath,
        content: fetched.content,
        encoding: fetched.encoding,
        kind: deriveSkillFileKind(relativePath),
      });
    }

    imported.push({
      skillPath: plan.skillPath,
      parsed: plan.parsed,
      files,
      skippedFiles: plan.skippedFiles,
      sourceRef: `${location.path}@${ref}:${plan.skillPath}`,
      sourceProvider: location.host.provider,
      sourceOrigin: isCloudGitHost(location.host) ? null : location.host.webUrl,
      sourceCommit: snapshot.commitSha,
      requestedRef: location.ref,
    });
  }

  return imported;
}

// ===== Internal helpers =====

/**
 * Per-repo snapshot cache. Keyed by API/web origin and `owner/repo@ref#tokenFingerprint` so
 * separate tokens (or no token) never share a cache entry — a token granting
 * access to a private repo doesn't leak its tree paths to a later unauth call.
 */
const repoCache = new LRUCacheManager<CachedRepo>({
  maxSize: REPO_CACHE_MAX_ENTRIES,
  defaultTtl: REPO_CACHE_TTL_MS,
});

function clientFor(
  access: GitAccess | undefined,
  location: RepoLocation,
): GitHostClient {
  return new GitHostClient(location.host, access?.token);
}

/**
 * Parse a repository URL against the access's host (public github.com when
 * there is none). An explicit `path` wins over a folder embedded in the URL.
 */
function parseRepoUrl(params: {
  repoUrl: string;
  path?: string;
  access?: GitAccess;
}): RepoLocation {
  const host = params.access?.host ?? gitHostFromUrl({ provider: "github" });
  let location: ReturnType<typeof parseGitRepoUrl>;
  try {
    location = parseGitRepoUrl({ input: params.repoUrl, host });
  } catch (error) {
    throw new SkillImportError(errorMessage(error));
  }
  return {
    host,
    path: location.path,
    ref: location.ref,
    subpath: normalizeSubpath(params.path ?? location.subpath),
  };
}

/**
 * Resolve a ref to a commit SHA and load the recursive tree, caching the
 * result so a follow-up call within the TTL pays no REST quota.
 */
async function loadRepoSnapshot(
  client: GitHostClient,
  location: RepoLocation,
): Promise<CachedRepo> {
  const cacheKey = repoCacheKey(client, location);
  const cached = repoCache.get(cacheKey);
  if (cached) return cached;

  let commitSha: string;
  try {
    commitSha = await client.resolveCommit(location.path, location.ref);
  } catch (error) {
    throw new SkillImportError(
      `Could not resolve ref "${location.ref ?? "HEAD"}" in ${location.path}: ${errorMessage(error)}`,
    );
  }

  let tree: TreeItem[];
  try {
    tree = await client.listTree(location.path, commitSha);
  } catch (error) {
    throw new SkillImportError(
      `Could not read repository tree: ${errorMessage(error)}`,
    );
  }

  const snapshot: CachedRepo = { commitSha, tree, manifests: new Map() };
  repoCache.set(cacheKey, snapshot);
  return snapshot;
}

function repoCacheKey(client: GitHostClient, location: RepoLocation): string {
  return `${location.host.apiUrl}|${location.path}@${location.ref ?? "HEAD"}#${client.cacheFingerprint()}`;
}

/**
 * Fetch one file's bytes: UTF-8 text for text files, or base64 (with
 * `encoding: "base64"`) for binary assets so the raw bytes survive a
 * round-trip through Postgres `text` storage. Null when missing, oversized,
 * or unreadable.
 */
async function fetchRawFile(
  client: GitHostClient,
  location: RepoLocation,
  commitSha: string,
  path: string,
): Promise<{ content: string; encoding: SkillFileEncoding } | null> {
  let buffer: Buffer | null;
  try {
    buffer = await client.readFile({
      repo: location.path,
      ref: commitSha,
      path,
      maxBytes: MAX_SKILL_FILE_BYTES,
    });
  } catch (error) {
    logger.warn(
      { path, error: errorMessage(error) },
      "[Skills] Raw file fetch failed",
    );
    return null;
  }
  if (buffer === null) return null;
  // Binary detection: a null byte (valid UTF-8, but unstorable in Postgres
  // `text`) or any invalid UTF-8 sequence means the bytes must be preserved
  // verbatim via base64 so the asset can be redistributed unchanged.
  if (buffer.includes(0)) {
    return { content: buffer.toString("base64"), encoding: "base64" };
  }
  try {
    return {
      // ignoreBOM keeps a leading BOM in the text so the stored bytes stay
      // faithful to the source file
      content: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(buffer),
      encoding: "utf8",
    };
  } catch {
    return { content: buffer.toString("base64"), encoding: "base64" };
  }
}

function normalizeSubpath(path: string): string {
  return normalizeGitSubpath(path);
}

function isUnderSubpath(filePath: string, subpath: string): boolean {
  if (!subpath) return true;
  return filePath === subpath || filePath.startsWith(`${subpath}/`);
}

/**
 * Whether a file lives inside a skill directory (recursively — `scripts/`,
 * `references/`, `assets/` subdirectories are part of the skill).
 */
function isUnderSkillDir(filePath: string, skillPath: string): boolean {
  return skillPath ? filePath.startsWith(`${skillPath}/`) : true;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Map `items` through `fn` with at most `limit` calls in flight. Results stay in
 * input order regardless of completion order, so callers can rely on positional
 * alignment with `items`.
 */
async function mapWithConcurrency<T, R>(params: {
  items: T[];
  limit: number;
  fn: (item: T, index: number) => Promise<R>;
}): Promise<R[]> {
  const { items, limit, fn } = params;
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
