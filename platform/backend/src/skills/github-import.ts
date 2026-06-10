import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { Octokit } from "@octokit/rest";
import { LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import type { SkillFileEncoding, SkillFileKind } from "@/types";
import {
  deriveSkillFileKind,
  type ParsedSkill,
  parseSkillManifest,
  SKILL_MANIFEST_FILENAME,
} from "./parser";

/**
 * Imports Agent Skills from GitHub repositories. A skill is any directory
 * containing a `SKILL.md` file; import is a one-time snapshot — the GitHub
 * token is used for the request and never persisted.
 *
 * Per-repo tree state from `discoverSkills` is cached briefly and reused by
 * `importSkills` so a discover → import round-trip from the UI doesn't pay the
 * REST quota cost twice. File contents are fetched from
 * `raw.githubusercontent.com`, which doesn't consume the REST API rate limit.
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
  parsed: ParsedSkill;
  files: {
    path: string;
    content: string;
    encoding: SkillFileEncoding;
    kind: SkillFileKind;
  }[];
  /** Provenance string, e.g. `owner/repo@main:skills/pdf`. */
  sourceRef: string;
  /** Commit SHA the snapshot was taken at. */
  sourceCommit: string;
}

interface RepoLocation {
  owner: string;
  repo: string;
  ref: string | null;
  subpath: string;
}

/** A single entry from `GET /repos/{owner}/{repo}/git/trees`. */
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
  githubToken?: string;
}): Promise<{ repoUrl: string; ref: string; skills: DiscoveredSkill[] }> {
  const location = parseRepoUrl(params.repoUrl, params.path);
  const octokit = createOctokit(params.githubToken);
  const snapshot = await loadRepoSnapshot(
    octokit,
    location,
    params.githubToken,
  );

  const manifestPaths = snapshot.tree
    .filter(
      (item) =>
        item.type === "blob" &&
        !!item.path &&
        basename(item.path) === SKILL_MANIFEST_FILENAME &&
        isUnderSubpath(item.path, location.subpath),
    )
    .map((item) => item.path as string);

  const skills: DiscoveredSkill[] = [];
  for (const manifestPath of manifestPaths) {
    const skillPath = dirname(manifestPath);
    let parsed = snapshot.manifests.get(manifestPath);
    if (!parsed) {
      const raw = await fetchRawFile(
        location,
        snapshot.commitSha,
        manifestPath,
        params.githubToken,
      );
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
    repoUrl: `${location.owner}/${location.repo}`,
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
  githubToken?: string;
  skillPaths: string[];
}): Promise<ImportedSkill[]> {
  const location = parseRepoUrl(params.repoUrl, params.path);
  const octokit = createOctokit(params.githubToken);
  const snapshot = await loadRepoSnapshot(
    octokit,
    location,
    params.githubToken,
  );
  const ref = location.ref ?? snapshot.commitSha;

  const imported: ImportedSkill[] = [];
  for (const skillPath of params.skillPaths) {
    const manifestPath = skillPath ? `${skillPath}/SKILL.md` : "SKILL.md";
    let parsed = snapshot.manifests.get(manifestPath);
    if (!parsed) {
      const raw = await fetchRawFile(
        location,
        snapshot.commitSha,
        manifestPath,
        params.githubToken,
      );
      if (raw === null || raw.encoding !== "utf8") {
        throw new SkillImportError(`No SKILL.md found at ${skillPath}`);
      }
      parsed = parseSkillManifest(raw.content);
      snapshot.manifests.set(manifestPath, parsed);
    }

    // Pre-filter using the tree's `size` field so we don't issue HTTP requests
    // for files we'd immediately drop on the response side.
    const resourcePaths = snapshot.tree
      .filter(
        (item) =>
          item.type === "blob" &&
          !!item.path &&
          isUnderSkillDir(item.path, skillPath) &&
          basename(item.path) !== SKILL_MANIFEST_FILENAME &&
          (typeof item.size !== "number" || item.size <= MAX_SKILL_FILE_BYTES),
      )
      .map((item) => item.path as string)
      .slice(0, MAX_FILES_PER_SKILL);

    const files: ImportedSkill["files"] = [];
    for (const absolutePath of resourcePaths) {
      const fetched = await fetchRawFile(
        location,
        snapshot.commitSha,
        absolutePath,
        params.githubToken,
      );
      if (fetched === null) continue;
      const relativePath = skillPath
        ? absolutePath.slice(skillPath.length + 1)
        : absolutePath;
      files.push({
        path: relativePath,
        content: fetched.content,
        encoding: fetched.encoding,
        kind: deriveSkillFileKind(relativePath),
      });
    }

    imported.push({
      parsed,
      files,
      sourceRef: `${location.owner}/${location.repo}@${ref}:${skillPath}`,
      sourceCommit: snapshot.commitSha,
    });
  }

  return imported;
}

// ===== Internal helpers =====

/**
 * Per-repo snapshot cache. Keyed by `owner/repo@ref#tokenFingerprint` so
 * separate tokens (or no token) never share a cache entry — a token granting
 * access to a private repo doesn't leak its tree paths to a later unauth call.
 */
const repoCache = new LRUCacheManager<CachedRepo>({
  maxSize: REPO_CACHE_MAX_ENTRIES,
  defaultTtl: REPO_CACHE_TTL_MS,
});

function createOctokit(token?: string): Octokit {
  return new Octokit(token ? { auth: token } : {});
}

/**
 * Parse a GitHub repo URL into an owner/repo/ref/subpath. Accepts
 * `owner/repo`, `github.com/owner/repo`, full https URLs, and
 * `/tree/<ref>/<subpath>` suffixes. An explicit `pathOverride` wins over a
 * subpath embedded in the URL.
 */
function parseRepoUrl(repoUrl: string, pathOverride?: string): RepoLocation {
  const trimmed = repoUrl.trim();
  if (!trimmed) {
    throw new SkillImportError("Repository URL is required");
  }

  const withoutProtocol = trimmed
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "");
  const segments = withoutProtocol.split("/").filter(Boolean);

  if (segments.length < 2) {
    throw new SkillImportError(
      "Repository URL must include an owner and repo, e.g. owner/repo",
    );
  }

  const [owner, repo, ...rest] = segments;
  let ref: string | null = null;
  let urlSubpath = "";

  if (rest[0] === "tree" && rest.length >= 2) {
    ref = rest[1];
    urlSubpath = rest.slice(2).join("/");
  }

  const subpath = normalizeSubpath(pathOverride ?? urlSubpath);
  return { owner, repo, ref, subpath };
}

/**
 * Resolve a ref to a commit SHA and load the recursive tree, caching the
 * result so a follow-up call within the TTL pays no REST quota.
 */
async function loadRepoSnapshot(
  octokit: Octokit,
  location: RepoLocation,
  token: string | undefined,
): Promise<CachedRepo> {
  const cacheKey = repoCacheKey(location, token);
  const cached = repoCache.get(cacheKey);
  if (cached) return cached;

  // Pass "HEAD" when no ref is provided — saves the separate default-branch
  // lookup `octokit.rest.repos.get` used to do.
  const ref = location.ref ?? "HEAD";

  let commitSha: string;
  try {
    const commit = await octokit.rest.repos.getCommit({
      owner: location.owner,
      repo: location.repo,
      ref,
    });
    commitSha = commit.data.sha;
  } catch (error) {
    throw new SkillImportError(
      `Could not resolve ref "${ref}" in ${location.owner}/${location.repo}: ${errorMessage(error)}`,
    );
  }

  let tree: TreeItem[];
  try {
    const treeResponse = await octokit.rest.git.getTree({
      owner: location.owner,
      repo: location.repo,
      tree_sha: commitSha,
      recursive: "true",
    });
    tree = treeResponse.data.tree;
  } catch (error) {
    throw new SkillImportError(
      `Could not read repository tree: ${errorMessage(error)}`,
    );
  }

  const snapshot: CachedRepo = {
    commitSha,
    tree,
    manifests: new Map(),
  };
  repoCache.set(cacheKey, snapshot);
  return snapshot;
}

function repoCacheKey(
  location: RepoLocation,
  token: string | undefined,
): string {
  // Fingerprint instead of raw token so the cache key never logs a credential
  // even if it ends up in a debug dump.
  const tokenFingerprint = token
    ? createHash("sha256").update(token).digest("hex").slice(0, 16)
    : "public";
  const ref = location.ref ?? "HEAD";
  return `${location.owner}/${location.repo}@${ref}#${tokenFingerprint}`;
}

/**
 * Fetch a file from `raw.githubusercontent.com`. This endpoint serves the
 * same bytes as `repos.getContent` but is not counted against the GitHub REST
 * rate limit, which is the limit that bites users importing many files.
 *
 * Returns `{ content, encoding }`: UTF-8 text for text files, or a
 * base64-encoded payload (with `encoding: "base64"`) for binary assets so the
 * raw bytes survive a round-trip through Postgres `text` storage.
 */
async function fetchRawFile(
  location: RepoLocation,
  commitSha: string,
  path: string,
  token: string | undefined,
): Promise<{ content: string; encoding: SkillFileEncoding } | null> {
  const url = `https://raw.githubusercontent.com/${location.owner}/${location.repo}/${commitSha}/${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw",
  };
  if (token) headers.Authorization = `token ${token}`;

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    logger.warn(
      { path, error: errorMessage(error) },
      "[Skills] Raw file fetch failed",
    );
    return null;
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    logger.warn(
      { path, status: response.status },
      "[Skills] Raw file fetch returned non-OK status",
    );
    return null;
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_SKILL_FILE_BYTES) {
    logger.warn(
      { path, size: contentLength },
      "[Skills] Skipping oversized file",
    );
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_SKILL_FILE_BYTES) {
    logger.warn(
      { path, size: buffer.length },
      "[Skills] Skipping oversized file",
    );
    return null;
  }
  // Null byte → binary. Preserve raw bytes by base64-encoding so we can
  // redistribute the asset verbatim later.
  if (buffer.includes(0)) {
    return { content: buffer.toString("base64"), encoding: "base64" };
  }
  return { content: buffer.toString("utf-8"), encoding: "utf8" };
}

function normalizeSubpath(path: string): string {
  return path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
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
