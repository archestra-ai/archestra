import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dump as dumpYaml } from "js-yaml";
import logger from "@/logging";
import type { SkillFile } from "@/types";
import {
  buildClaudeMarketplaceManifest,
  buildClaudePluginManifest,
  buildCodexMarketplaceManifest,
  buildCodexPluginManifest,
  type MarketplaceSkillInput,
  resolveMarketplaceSkills,
} from "./manifest";

/**
 * Builds a one-repo-per-share-link on-disk git repository that serves both the
 * Claude Code and Codex CLI marketplace layouts. Each call advances the repo by
 * a single child commit when content changes, so existing `git clone`d copies
 * can `git pull` without unrelated-history conflicts.
 */

export interface MaterializeSkillInput {
  id: string;
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  version?: string | null;
  updatedAt: Date;
  files: SkillFile[];
}

export interface MaterializeRequest {
  linkId: string;
  marketplaceName: string;
  ownerName: string;
  displayName: string;
  skills: MaterializeSkillInput[];
}

export interface MaterializeResult {
  repoPath: string;
  commitHash: string;
  contentHash: string;
  /** True when the call produced a new commit (vs. reused an existing HEAD). */
  reused: boolean;
}

export interface MaterializerOptions {
  cacheDir: string;
  gitBinaryPath?: string;
  /** Author/committer identity stamped on every commit. */
  identity?: { name: string; email: string };
}

const DEFAULT_IDENTITY = {
  name: "Archestra Marketplace",
  email: "marketplace@archestra.local",
};

/** Commit-message marker so we can recover the content hash from `git log`. */
const CONTENT_HASH_PREFIX = "content-hash:";

export class MarketplaceMaterializer {
  private readonly cacheDir: string;
  private readonly gitBinaryPath: string;
  private readonly identity: { name: string; email: string };
  /** Per-link write serializer; subsequent callers chain behind the in-flight call. */
  private readonly locks = new Map<string, Promise<MaterializeResult>>();

  constructor(options: MaterializerOptions) {
    this.cacheDir = options.cacheDir;
    this.gitBinaryPath = options.gitBinaryPath ?? "git";
    this.identity = options.identity ?? DEFAULT_IDENTITY;
  }

  /** On-disk path for a given share link's repo, regardless of materialization state. */
  repoPathFor(linkId: string): string {
    return path.join(this.cacheDir, linkId, "repo");
  }

  async materialize(req: MaterializeRequest): Promise<MaterializeResult> {
    const previous: Promise<unknown> =
      this.locks.get(req.linkId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.doMaterialize(req));
    this.locks.set(req.linkId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(req.linkId) === next) this.locks.delete(req.linkId);
    }
  }

  /** Drop the on-disk repo for a revoked or hard-deleted share link. */
  async revoke(linkId: string): Promise<void> {
    const dir = path.join(this.cacheDir, linkId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  /**
   * Remove repo directories whose link id is not in `liveLinkIds`. Intended as
   * a startup sweep; safe to call against an empty or missing cache dir.
   */
  async sweepOrphans(liveLinkIds: Iterable<string>): Promise<string[]> {
    const live = new Set(liveLinkIds);
    let entries: string[];
    try {
      entries = await fs.readdir(this.cacheDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const removed: string[] = [];
    for (const entry of entries) {
      if (live.has(entry)) continue;
      await fs.rm(path.join(this.cacheDir, entry), {
        recursive: true,
        force: true,
      });
      removed.push(entry);
    }
    return removed;
  }

  private async doMaterialize(
    req: MaterializeRequest,
  ): Promise<MaterializeResult> {
    const repoPath = this.repoPathFor(req.linkId);
    const contentHash = computeContentHash(req.skills);
    const existingHash = await readHeadContentHash(
      repoPath,
      this.gitBinaryPath,
    );

    if (existingHash === contentHash) {
      const head = await getHead(repoPath, this.gitBinaryPath);
      return { repoPath, commitHash: head, contentHash, reused: true };
    }

    const isFirstCommit = existingHash === null;
    await fs.mkdir(repoPath, { recursive: true });

    if (isFirstCommit) {
      await runGit({
        binary: this.gitBinaryPath,
        cwd: repoPath,
        args: ["init", "--quiet", "--initial-branch=main"],
      });
    } else {
      // clear any previously tracked files so the new layout is the only thing committed
      await runGit({
        binary: this.gitBinaryPath,
        cwd: repoPath,
        args: ["rm", "-rf", "--quiet", "."],
      });
    }

    await writeRepoLayout(repoPath, req);

    const commitDate = pickCommitDate(req.skills);
    await runGit({
      binary: this.gitBinaryPath,
      cwd: repoPath,
      args: ["add", "--all", "."],
    });
    await runGit({
      binary: this.gitBinaryPath,
      cwd: repoPath,
      args: [
        "-c",
        `user.name=${this.identity.name}`,
        "-c",
        `user.email=${this.identity.email}`,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        `${commitMessageFor(req.skills.length)} ${CONTENT_HASH_PREFIX}${contentHash}`,
      ],
      env: {
        GIT_AUTHOR_DATE: commitDate,
        GIT_COMMITTER_DATE: commitDate,
      },
    });

    const head = await getHead(repoPath, this.gitBinaryPath);
    return { repoPath, commitHash: head, contentHash, reused: false };
  }
}

// ===== Internal helpers =====

function commitMessageFor(skillCount: number): string {
  return skillCount === 1
    ? "Update skill marketplace"
    : `Update skill marketplace (${skillCount} skills)`;
}

function computeContentHash(skills: MaterializeSkillInput[]): string {
  const canonical = [...skills]
    .map((skill) => ({
      id: skill.id,
      updatedAt: skill.updatedAt.toISOString(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function pickCommitDate(skills: MaterializeSkillInput[]): string {
  // newest updatedAt across the bundle → deterministic across replicas
  const latest = skills.reduce<number>(
    (max, skill) => Math.max(max, skill.updatedAt.getTime()),
    0,
  );
  return new Date(latest || Date.now()).toISOString();
}

async function readHeadContentHash(
  repoPath: string,
  gitBinary: string,
): Promise<string | null> {
  try {
    await fs.access(path.join(repoPath, ".git"));
  } catch {
    return null;
  }
  try {
    const result = await runGit({
      binary: gitBinary,
      cwd: repoPath,
      args: ["log", "-1", "--pretty=%B"],
    });
    const match = result.stdout.match(
      new RegExp(`${CONTENT_HASH_PREFIX}([a-f0-9]+)`),
    );
    return match?.[1] ?? null;
  } catch (err) {
    logger.warn(
      { err, repoPath },
      "materialize: failed to read HEAD content hash; will rebuild",
    );
    return null;
  }
}

async function getHead(repoPath: string, gitBinary: string): Promise<string> {
  const result = await runGit({
    binary: gitBinary,
    cwd: repoPath,
    args: ["rev-parse", "HEAD"],
  });
  return result.stdout.trim();
}

async function writeRepoLayout(
  repoPath: string,
  req: MaterializeRequest,
): Promise<void> {
  const resolved = resolveMarketplaceSkills(
    req.skills.map<MarketplaceSkillInput>((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      updatedAt: skill.updatedAt,
    })),
  );

  await fs.mkdir(path.join(repoPath, ".claude-plugin"), { recursive: true });
  await fs.mkdir(path.join(repoPath, ".agents/plugins"), { recursive: true });

  await writeJson(
    path.join(repoPath, ".claude-plugin/marketplace.json"),
    buildClaudeMarketplaceManifest({
      marketplaceName: req.marketplaceName,
      ownerName: req.ownerName,
      skills: resolved,
    }),
  );

  await writeJson(
    path.join(repoPath, ".agents/plugins/marketplace.json"),
    buildCodexMarketplaceManifest({
      marketplaceName: req.marketplaceName,
      displayName: req.displayName,
      skills: resolved,
    }),
  );

  for (let i = 0; i < resolved.length; i += 1) {
    const slug = resolved[i].slug;
    const skill = req.skills[i];
    await writePluginDirectory({ repoPath, slug, skill });
  }
}

async function writePluginDirectory(params: {
  repoPath: string;
  slug: string;
  skill: MaterializeSkillInput;
}): Promise<void> {
  const { repoPath, slug, skill } = params;
  const pluginRoot = path.join(repoPath, "plugins", slug);
  const skillRoot = path.join(pluginRoot, "skills", slug);

  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  await fs.mkdir(skillRoot, { recursive: true });

  const skillInput: MarketplaceSkillInput = {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    updatedAt: skill.updatedAt,
  };

  await writeJson(
    path.join(pluginRoot, ".claude-plugin/plugin.json"),
    buildClaudePluginManifest({ skill: skillInput, slug }),
  );
  await writeJson(
    path.join(pluginRoot, ".codex-plugin/plugin.json"),
    buildCodexPluginManifest({ skill: skillInput, slug }),
  );

  await fs.writeFile(
    path.join(skillRoot, "SKILL.md"),
    buildSkillMarkdown(skill),
    "utf8",
  );

  // resource files preserve their stored relative path under skills/<slug>/
  for (const file of skill.files) {
    const relPath = file.path.replace(/^\.?\//, "");
    const target = path.join(skillRoot, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (file.encoding === "base64") {
      await fs.writeFile(target, Buffer.from(file.content, "base64"));
    } else {
      await fs.writeFile(target, file.content, "utf8");
    }
  }
}

function buildSkillMarkdown(skill: MaterializeSkillInput): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  if (skill.license) frontmatter.license = skill.license;
  if (skill.compatibility) frontmatter.compatibility = skill.compatibility;
  if (skill.metadata && Object.keys(skill.metadata).length > 0) {
    frontmatter.metadata = skill.metadata;
  }

  const yamlBody = dumpYaml(frontmatter, {
    sortKeys: false,
    lineWidth: -1,
    quotingType: '"',
    forceQuotes: false,
    noRefs: true,
  });

  const body = skill.content.trim();
  return `---\n${yamlBody}---\n\n${body}\n`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface RunGitParams {
  binary: string;
  cwd: string;
  args: string[];
  env?: Record<string, string>;
}

function runGit(
  params: RunGitParams,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(params.binary, params.args, {
      cwd: params.cwd,
      env: { ...process.env, ...(params.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.once("error", reject);
    proc.once("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode === 0) {
        resolve({ stdout, stderr, code: exitCode });
        return;
      }
      reject(
        new Error(
          `git ${params.args[0]} exited with code ${exitCode}: ${stderr.trim()}`,
        ),
      );
    });
  });
}
