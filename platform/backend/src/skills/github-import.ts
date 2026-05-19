import { Octokit } from "@octokit/rest";
import logger from "@/logging";
import type { SkillFileKind } from "@/types";
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
 */

/** Skip individual resource files larger than this (text only, no binaries). */
const MAX_SKILL_FILE_BYTES = 256 * 1024;
/** Cap on resource files copied per skill. */
const MAX_FILES_PER_SKILL = 50;

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
  /** Number of bundled resource files (excludes SKILL.md). */
  fileCount: number;
}

/** A fully fetched skill ready to be persisted. */
interface ImportedSkill {
  parsed: ParsedSkill;
  files: { path: string; content: string; kind: SkillFileKind }[];
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
  const { commitSha, tree } = await fetchRepoTree(octokit, location);

  const manifestPaths = tree
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
    const raw = await fetchFileContent(octokit, location, manifestPath);
    if (raw === null) continue;

    let parsed: ParsedSkill;
    try {
      parsed = parseSkillManifest(raw);
    } catch (error) {
      logger.warn(
        { manifestPath, error: errorMessage(error) },
        "[Skills] Skipping skill with unparseable SKILL.md",
      );
      continue;
    }

    const fileCount = tree.filter(
      (item) =>
        item.type === "blob" &&
        !!item.path &&
        isUnderSkillDir(item.path, skillPath) &&
        basename(item.path) !== SKILL_MANIFEST_FILENAME,
    ).length;

    skills.push({
      skillPath,
      name: parsed.name,
      description: parsed.description,
      compatibility: parsed.compatibility,
      fileCount,
    });
  }

  return {
    repoUrl: `${location.owner}/${location.repo}`,
    ref: location.ref ?? commitSha,
    skills,
  };
}

/**
 * Fetch the full contents of the selected skill directories. Binary files are
 * skipped — only text resources are imported.
 */
export async function importSkills(params: {
  repoUrl: string;
  path?: string;
  githubToken?: string;
  skillPaths: string[];
}): Promise<ImportedSkill[]> {
  const location = parseRepoUrl(params.repoUrl, params.path);
  const octokit = createOctokit(params.githubToken);
  const { commitSha, tree } = await fetchRepoTree(octokit, location);
  const ref = location.ref ?? commitSha;

  const imported: ImportedSkill[] = [];
  for (const skillPath of params.skillPaths) {
    const manifestPath = skillPath ? `${skillPath}/SKILL.md` : "SKILL.md";
    const raw = await fetchFileContent(octokit, location, manifestPath);
    if (raw === null) {
      throw new SkillImportError(`No SKILL.md found at ${skillPath}`);
    }
    const parsed = parseSkillManifest(raw);

    const resourcePaths = tree
      .filter(
        (item) =>
          item.type === "blob" &&
          !!item.path &&
          isUnderSkillDir(item.path, skillPath) &&
          basename(item.path) !== SKILL_MANIFEST_FILENAME,
      )
      .map((item) => item.path as string)
      .slice(0, MAX_FILES_PER_SKILL);

    const files: ImportedSkill["files"] = [];
    for (const absolutePath of resourcePaths) {
      const content = await fetchFileContent(octokit, location, absolutePath);
      if (content === null) continue;
      const relativePath = skillPath
        ? absolutePath.slice(skillPath.length + 1)
        : absolutePath;
      files.push({
        path: relativePath,
        content,
        kind: deriveSkillFileKind(relativePath),
      });
    }

    imported.push({
      parsed,
      files,
      sourceRef: `${location.owner}/${location.repo}@${ref}:${skillPath}`,
      sourceCommit: commitSha,
    });
  }

  return imported;
}

// ===== Internal helpers =====

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

async function fetchRepoTree(
  octokit: Octokit,
  location: RepoLocation,
): Promise<{
  commitSha: string;
  tree: { type?: string; path?: string }[];
}> {
  const ref = location.ref ?? (await getDefaultBranch(octokit, location));

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

  try {
    const treeResponse = await octokit.rest.git.getTree({
      owner: location.owner,
      repo: location.repo,
      tree_sha: commitSha,
      recursive: "true",
    });
    return { commitSha, tree: treeResponse.data.tree };
  } catch (error) {
    throw new SkillImportError(
      `Could not read repository tree: ${errorMessage(error)}`,
    );
  }
}

async function getDefaultBranch(
  octokit: Octokit,
  location: RepoLocation,
): Promise<string> {
  try {
    const repo = await octokit.rest.repos.get({
      owner: location.owner,
      repo: location.repo,
    });
    return repo.data.default_branch;
  } catch (error) {
    throw new SkillImportError(
      `Could not access ${location.owner}/${location.repo}: ${errorMessage(error)}`,
    );
  }
}

/** Fetch and decode a single file as UTF-8 text. Returns null for binaries. */
async function fetchFileContent(
  octokit: Octokit,
  location: RepoLocation,
  path: string,
): Promise<string | null> {
  let data: unknown;
  try {
    const response = await octokit.rest.repos.getContent({
      owner: location.owner,
      repo: location.repo,
      path,
      ...(location.ref ? { ref: location.ref } : {}),
    });
    data = response.data;
  } catch (error) {
    logger.warn(
      { path, error: errorMessage(error) },
      "[Skills] Failed to fetch file content",
    );
    return null;
  }

  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("content" in data)
  ) {
    return null;
  }

  const { content, size } = data as { content: string; size: number };
  if (typeof size === "number" && size > MAX_SKILL_FILE_BYTES) {
    logger.warn({ path, size }, "[Skills] Skipping oversized file");
    return null;
  }

  const buffer = Buffer.from(content, "base64");
  if (buffer.includes(0)) {
    // Null byte — treat as binary and skip (binary assets are unsupported).
    return null;
  }
  return buffer.toString("utf-8");
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
