import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SkillShareLinkRevisionModel } from "@/models";
import type {
  RevisionPayload,
  RevisionPayloadFile,
  SkillShareLinkRevision,
} from "@/types/skill-share-link-revision";
import { isUniqueConstraintError } from "@/utils/db";
import { computeLayout, type MaterializeRequest } from "./layout";

/**
 * Sequence appends are serialized in-process by the per-link lock, but multiple
 * replicas share the same revision table. When two pods materialize the same
 * link concurrently they can derive the same `sequence`; the unique index
 * rejects the loser. Re-read the latest revision and retry rather than failing
 * the clone.
 */
const REVISION_APPEND_MAX_ATTEMPTS = 5;

/**
 * Materializes a share link's git repository on disk, backed by an append-only
 * revision history in the database. Each revision row encodes the full file
 * list at that point in time plus the deterministic commit SHA that results.
 *
 * Cache (`cacheDir/<linkId>/repo`) is a pure performance optimization: it can
 * be wiped at any time and rebuilt by replaying revisions in `sequence` order
 * with byte-identical SHAs. This keeps `git pull` working across server
 * restarts, container redeploys, and host migrations.
 */

/** @public — re-exported for testability */
export type { MaterializeRequest, MaterializeSkillInput } from "./layout";

interface MaterializeResult {
  repoPath: string;
  commitHash: string;
  contentHash: string;
  /** True when the call returned the existing HEAD without writing a new commit. */
  reused: boolean;
}

interface MaterializerOptions {
  cacheDir: string;
  gitBinaryPath?: string;
  identity?: { name: string; email: string };
  /** Override for tests; defaults to the SkillShareLinkRevisionModel. */
  revisionStore?: RevisionStore;
}

/** @public — exported for testability */
export interface AppendRevisionParams {
  linkId: string;
  contentHash: string;
  commitSha: string;
  parentSha: string | null;
  createdAt: Date;
  payload: RevisionPayload;
}

/** @public — exported for testability */
export interface RevisionStore {
  getLatestByLink(linkId: string): Promise<SkillShareLinkRevision | null>;
  listByLink(linkId: string): Promise<SkillShareLinkRevision[]>;
  append(
    params: AppendRevisionParams,
    sequence: number,
  ): Promise<SkillShareLinkRevision>;
}

const DEFAULT_IDENTITY = {
  name: "Archestra Marketplace",
  email: "marketplace@archestra.local",
};

export class MarketplaceMaterializer {
  private readonly cacheDir: string;
  private readonly gitBinaryPath: string;
  private readonly identity: { name: string; email: string };
  private readonly revisionStore: RevisionStore;
  /** Per-link write serializer; subsequent callers chain behind the in-flight call. */
  private readonly locks = new Map<string, Promise<MaterializeResult>>();

  constructor(options: MaterializerOptions) {
    this.cacheDir = options.cacheDir;
    this.gitBinaryPath = options.gitBinaryPath ?? "git";
    this.identity = options.identity ?? DEFAULT_IDENTITY;
    this.revisionStore = options.revisionStore ?? defaultRevisionStore();
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
    // chain behind any in-flight materialize so we don't yank pack files out
    // from under a streaming clone. swallow upstream errors — the rm runs
    // regardless of how the previous call ended.
    const previous: Promise<unknown> =
      this.locks.get(linkId) ?? Promise.resolve();
    const removed: Promise<MaterializeResult> = previous
      .catch(() => undefined)
      .then(async () => {
        const dir = path.join(this.cacheDir, linkId);
        await fs.rm(dir, { recursive: true, force: true });
        // returned value is unused; revoke() callers await for completion only
        return REVOKED_PLACEHOLDER;
      });
    this.locks.set(linkId, removed);
    try {
      await removed;
    } finally {
      if (this.locks.get(linkId) === removed) this.locks.delete(linkId);
    }
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
      if (!UUID_RE.test(entry)) continue;
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
    const files = computeLayout(req);
    const contentHash = computeContentHash(files);
    const repoPath = this.repoPathFor(req.linkId);

    let latest = await this.revisionStore.getLatestByLink(req.linkId);

    if (latest && latest.contentHash === contentHash) {
      await this.syncDiskToRevisions(req.linkId);
      return {
        repoPath,
        commitHash: latest.commitSha,
        contentHash,
        reused: true,
      };
    }

    for (let attempt = 0; ; attempt++) {
      await this.syncDiskToRevisions(req.linkId);

      const sequence = (latest?.sequence ?? 0) + 1;
      const createdAt = roundToSeconds(new Date());
      const message = formatMessage(sequence, contentHash);

      const commitSha = await this.commitOnDisk({
        repoPath,
        files,
        parentSha: latest?.commitSha ?? null,
        date: createdAt,
        message,
      });

      try {
        await this.revisionStore.append(
          {
            linkId: req.linkId,
            contentHash,
            commitSha,
            parentSha: latest?.commitSha ?? null,
            createdAt,
            payload: { files },
          },
          sequence,
        );
        return { repoPath, commitHash: commitSha, contentHash, reused: false };
      } catch (error) {
        const lastAttempt = attempt >= REVISION_APPEND_MAX_ATTEMPTS - 1;
        if (
          lastAttempt ||
          !isUniqueConstraintError(
            error,
            "skill_share_link_revision_link_seq_idx",
          )
        ) {
          throw error;
        }

        // Another replica appended this sequence first. Re-read the latest
        // revision; if it already produced our content, reuse it, otherwise
        // retry on top of the new head.
        latest = await this.revisionStore.getLatestByLink(req.linkId);
        if (latest && latest.contentHash === contentHash) {
          await this.syncDiskToRevisions(req.linkId);
          return {
            repoPath,
            commitHash: latest.commitSha,
            contentHash,
            reused: true,
          };
        }
      }
    }
  }

  private async syncDiskToRevisions(linkId: string): Promise<void> {
    const revisions = await this.revisionStore.listByLink(linkId);
    const expectedHead = revisions.at(-1)?.commitSha ?? null;
    const repoPath = this.repoPathFor(linkId);

    const diskHead = await this.readDiskHead(repoPath);
    if (diskHead === expectedHead) {
      // already in sync — but a brand-new link still needs `.git` initialized
      // so the upcoming commit has somewhere to land
      if (expectedHead === null) await this.initEmptyRepo(repoPath);
      return;
    }

    await fs.rm(repoPath, { recursive: true, force: true });
    await this.initEmptyRepo(repoPath);

    let parentSha: string | null = null;
    for (const rev of revisions) {
      const sha = await this.commitOnDisk({
        repoPath,
        files: rev.payload.files,
        parentSha,
        date: rev.createdAt,
        message: formatMessage(rev.sequence, rev.contentHash),
      });
      if (sha !== rev.commitSha) {
        throw new Error(
          `materialize: replay SHA mismatch for link ${linkId} sequence ${rev.sequence}: expected ${rev.commitSha}, got ${sha}`,
        );
      }
      parentSha = sha;
    }
  }

  private async readDiskHead(repoPath: string): Promise<string | null> {
    try {
      await fs.access(path.join(repoPath, ".git"));
    } catch {
      return null;
    }
    try {
      const res = await runGit({
        binary: this.gitBinaryPath,
        cwd: repoPath,
        args: ["rev-parse", "HEAD"],
      });
      return res.stdout.trim();
    } catch {
      return null;
    }
  }

  private async initEmptyRepo(repoPath: string): Promise<void> {
    await fs.mkdir(repoPath, { recursive: true });
    await runGit({
      binary: this.gitBinaryPath,
      cwd: repoPath,
      args: ["init", "--quiet", "--initial-branch=main"],
    });
    // disable executable-bit tracking so replays don't depend on host umask
    await runGit({
      binary: this.gitBinaryPath,
      cwd: repoPath,
      args: ["config", "core.fileMode", "false"],
    });
  }

  private async commitOnDisk(params: {
    repoPath: string;
    files: RevisionPayloadFile[];
    parentSha: string | null;
    date: Date;
    message: string;
  }): Promise<string> {
    await wipeWorkingTree(params.repoPath);

    for (const file of params.files) {
      const target = path.join(params.repoPath, ...file.path.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const buf =
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64")
          : Buffer.from(file.content, "utf8");
      await fs.writeFile(target, buf);
    }

    await runGit({
      binary: this.gitBinaryPath,
      cwd: params.repoPath,
      args: ["add", "--all", "."],
    });
    const treeRes = await runGit({
      binary: this.gitBinaryPath,
      cwd: params.repoPath,
      args: ["write-tree"],
    });
    const treeSha = treeRes.stdout.trim();

    const dateStr = toGitDate(params.date);
    const env = {
      GIT_AUTHOR_NAME: this.identity.name,
      GIT_AUTHOR_EMAIL: this.identity.email,
      GIT_AUTHOR_DATE: dateStr,
      GIT_COMMITTER_NAME: this.identity.name,
      GIT_COMMITTER_EMAIL: this.identity.email,
      GIT_COMMITTER_DATE: dateStr,
    };
    const commitArgs = ["commit-tree", treeSha];
    if (params.parentSha) commitArgs.push("-p", params.parentSha);
    commitArgs.push("-m", params.message);

    const commitRes = await runGit({
      binary: this.gitBinaryPath,
      cwd: params.repoPath,
      args: commitArgs,
      env,
    });
    const commitSha = commitRes.stdout.trim();

    await runGit({
      binary: this.gitBinaryPath,
      cwd: params.repoPath,
      args: ["update-ref", "refs/heads/main", commitSha],
    });

    return commitSha;
  }
}

// ===== Internal helpers =====

function defaultRevisionStore(): RevisionStore {
  return {
    getLatestByLink: (linkId) =>
      SkillShareLinkRevisionModel.getLatestByLink(linkId),
    listByLink: (linkId) => SkillShareLinkRevisionModel.listByLink(linkId),
    append: (params, sequence) =>
      SkillShareLinkRevisionModel.append(params, sequence),
  };
}

function computeContentHash(files: RevisionPayloadFile[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(f.path);
    h.update("\0");
    h.update(f.mode);
    h.update("\0");
    h.update(f.encoding);
    h.update("\0");
    h.update(f.content);
    h.update("\0");
  }
  return h.digest("hex");
}

function roundToSeconds(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

function toGitDate(d: Date): string {
  return `${Math.floor(d.getTime() / 1000)} +0000`;
}

function formatMessage(sequence: number, contentHash: string): string {
  return `Snapshot ${sequence}\n\ncontent-hash: ${contentHash}\n`;
}

async function wipeWorkingTree(repoPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(repoPath);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ".git") continue;
    await fs.rm(path.join(repoPath, entry), { recursive: true, force: true });
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// sentinel slotted into the per-link lock map when revoke() chains behind an
// in-flight materialize; never observed by callers.
const REVOKED_PLACEHOLDER: MaterializeResult = {
  repoPath: "",
  commitHash: "",
  contentHash: "",
  reused: false,
};

function scrubGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("GIT_")) continue;
    out[k] = v;
  }
  return out;
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
      // strip host GIT_* env so e.g. an operator-set GIT_DIR or
      // GIT_AUTHOR_DATE can't divert commits or break replay determinism
      env: { ...scrubGitEnv(process.env), ...(params.env ?? {}) },
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
    proc.once("close", (code, signal) => {
      // a signal-killed process has code=null; never treat that as success
      if (signal) {
        reject(
          new Error(
            `git ${params.args[0]} terminated by signal ${signal}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      const exitCode = code ?? -1;
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
