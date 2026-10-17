import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import logger from "@/logging";
import { SkillShareLinkRevisionModel } from "@/models";
import {
  computePluginDeliveryStats,
  pluginDeliveryBudgetError,
} from "@/plugins/delivery-budget";
import type {
  MarketplaceRepoRef,
  RevisionPayloadFile,
  SkillShareLinkRevision,
} from "@/types/skill-share-link-revision";
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
 * Materializes a marketplace git repository on disk, backed by an append-only
 * revision history in the database. Each revision row encodes the full file
 * list at that point in time plus the deterministic commit SHA that results.
 *
 * Cache (`cacheDir/<ownerId>/repo`) is a pure performance optimization: it can
 * be wiped at any time and rebuilt by replaying revisions in `sequence` order
 * with byte-identical SHAs. This keeps `git pull` working across server
 * restarts, container redeploys, and host migrations.
 */

/** @public — re-exported for testability */
export type {
  MaterializePluginInput,
  MaterializeRequest,
  MaterializeSkillInput,
} from "./layout";

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
}

export class MarketplaceMaterializationConflictError extends Error {
  constructor() {
    super("Marketplace source changed during materialization; retry");
    this.name = "MarketplaceMaterializationConflictError";
  }
}

const DEFAULT_IDENTITY = {
  // white-label-ok: names the vendor's own hosted marketplace, not this deployment
  name: "Archestra Marketplace",
  email: "marketplace@archestra.local",
};

export class MarketplaceMaterializer {
  private readonly cacheDir: string;
  private readonly gitBinaryPath: string;
  private readonly identity: { name: string; email: string };
  /** Per-repo write serializer; subsequent callers chain behind the in-flight call. */
  private readonly locks = new Map<string, Promise<MaterializeResult>>();

  constructor(options: MaterializerOptions) {
    this.cacheDir = options.cacheDir;
    this.gitBinaryPath = options.gitBinaryPath ?? "git";
    this.identity = options.identity ?? DEFAULT_IDENTITY;
  }

  /** On-disk path for a given owner's repo, regardless of materialization state. */
  repoPathFor(ref: MarketplaceRepoRef): string {
    return path.join(this.cacheDir, ref.id, "repo");
  }

  async materialize(req: MaterializeRequest): Promise<MaterializeResult> {
    const previous: Promise<unknown> =
      this.locks.get(req.ref.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.doMaterialize(req));
    this.locks.set(req.ref.id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(req.ref.id) === next) this.locks.delete(req.ref.id);
    }
  }

  /** Drop the on-disk repo for a revoked or hard-deleted owner. */
  async revoke(ref: MarketplaceRepoRef): Promise<void> {
    // chain behind any in-flight materialize so we don't yank pack files out
    // from under a streaming clone. swallow upstream errors — the rm runs
    // regardless of how the previous call ended.
    const previous: Promise<unknown> =
      this.locks.get(ref.id) ?? Promise.resolve();
    const removed: Promise<MaterializeResult> = previous
      .catch(() => undefined)
      .then(async () => {
        const dir = path.join(this.cacheDir, ref.id);
        await fs.rm(dir, { recursive: true, force: true });
        // returned value is unused; revoke() callers await for completion only
        return REVOKED_PLACEHOLDER;
      });
    this.locks.set(ref.id, removed);
    try {
      await removed;
    } finally {
      if (this.locks.get(ref.id) === removed) this.locks.delete(ref.id);
    }
  }

  /**
   * Remove repo directories whose owner id is not in `liveOwnerIds`. Intended as
   * a startup sweep; safe to call against an empty or missing cache dir.
   */
  async sweepOrphans(liveOwnerIds: Iterable<string>): Promise<string[]> {
    const live = new Set(liveOwnerIds);
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
    const deliveryError = pluginDeliveryBudgetError(
      computePluginDeliveryStats(req.plugins ?? []),
    );
    if (deliveryError) throw new Error(deliveryError);
    const repoPath = this.repoPathFor(req.ref);

    let latest = await SkillShareLinkRevisionModel.getLatest(req.ref);

    for (let attempt = 0; ; attempt++) {
      const currentSequence = latest?.sequence ?? 0;
      const currentFiles = computeLayout(req, currentSequence);
      const currentContentHash = computeContentHash(currentFiles);

      if (latest && latest.contentHash === currentContentHash) {
        await this.syncDiskToRevisions(req.ref, latest.commitSha);
        return {
          repoPath,
          commitHash: latest.commitSha,
          contentHash: currentContentHash,
          reused: true,
        };
      }

      const sequence = currentSequence + 1;
      const files = computeLayout(req, sequence);
      const contentHash = computeContentHash(files);
      await this.syncDiskToRevisions(req.ref, latest?.commitSha ?? null);

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
        await SkillShareLinkRevisionModel.append(
          {
            ref: req.ref,
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
          !SkillShareLinkRevisionModel.isSequenceConflict(error, req.ref)
        ) {
          throw error;
        }

        // Another replica appended this sequence first. Re-read the latest and
        // rerender against its sequence. If the winner carried different
        // source bytes, this request is stale and must never append on top of
        // it (that would roll the marketplace back at a higher version).
        latest = await SkillShareLinkRevisionModel.getLatest(req.ref);
        if (!latest) throw new MarketplaceMaterializationConflictError();
        const rerenderedHash = computeContentHash(
          computeLayout(req, latest.sequence),
        );
        if (latest.contentHash !== rerenderedHash) {
          throw new MarketplaceMaterializationConflictError();
        }
      }
    }
  }

  private async syncDiskToRevisions(
    ref: MarketplaceRepoRef,
    expectedHead: string | null,
  ): Promise<void> {
    const repoPath = this.repoPathFor(ref);

    // every git request of a clone lands here; only load the full revision
    // history (all file payloads) when the disk actually needs a replay
    const diskHead = await this.readDiskHead(repoPath);
    if (diskHead === expectedHead) {
      // already in sync — but a brand-new repo still needs `.git` initialized
      // so the upcoming commit has somewhere to land
      if (expectedHead === null) await this.initEmptyRepo(repoPath);
      return;
    }

    const startedAt = Date.now();
    let fallbackReason =
      diskHead === null ? "no repo on disk" : "no stored revisions";
    // a throw (git error, replay SHA mismatch) means a corrupt repo or a bug,
    // unlike the expected reasons for a full rebuild
    let incrementalFailed = false;
    if (diskHead !== null && expectedHead !== null) {
      try {
        const result = await this.replayIncremental({
          ref,
          repoPath,
          expectedHead,
        });
        if (typeof result !== "string") {
          logReplay({
            ref,
            mode: "incremental",
            baseSequence: result.baseSequence,
            replayed: result.replayed,
            startedAt,
          });
          return;
        }
        fallbackReason = result;
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message : String(error);
        incrementalFailed = true;
      }
    }

    const revisions = await SkillShareLinkRevisionModel.list(ref);
    await fs.rm(repoPath, { recursive: true, force: true });
    await this.initEmptyRepo(repoPath);
    await this.replayRevisions({ ref, repoPath, revisions, parentSha: null });
    logReplay({
      ref,
      mode: "full",
      baseSequence: 0,
      replayed: revisions.length,
      startedAt,
      fallbackReason,
      level: incrementalFailed ? "warn" : "info",
    });
  }

  /**
   * Commit SHAs are deterministic over the whole parent chain, so a disk commit
   * equal to a stored `commitSha` proves the disk history up to it matches the
   * stored chain. Rewind `main` to the newest such commit (HEAD itself when this
   * replica is merely behind; its parent when a lost append left an orphan) and
   * replay only the newer revisions. Returns a reason string when the disk can't
   * be caught up this way and the caller should rebuild from scratch.
   */
  private async replayIncremental(params: {
    ref: MarketplaceRepoRef;
    repoPath: string;
    expectedHead: string;
  }): Promise<{ baseSequence: number; replayed: number } | string> {
    const { ref, repoPath, expectedHead } = params;
    const index = await SkillShareLinkRevisionModel.listCommitIndex(ref);
    const sequenceBySha = new Map(
      index.map((rev) => [rev.commitSha, rev.sequence]),
    );
    const expectedSequence = sequenceBySha.get(expectedHead);
    if (expectedSequence === undefined) {
      return "expected head is not in the stored chain";
    }

    const history = await runGit({
      binary: this.gitBinaryPath,
      cwd: repoPath,
      args: ["rev-list", "--first-parent", "HEAD"],
    });
    const base = history.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((sha) => sequenceBySha.has(sha));
    if (!base) return "no stored commit in the disk history";
    const baseSequence = sequenceBySha.get(base) ?? 0;
    if (baseSequence > expectedSequence) {
      return "disk base is newer than the expected head";
    }

    await runGit({
      binary: this.gitBinaryPath,
      cwd: repoPath,
      args: ["update-ref", "refs/heads/main", base],
    });
    const revisions = await SkillShareLinkRevisionModel.listAfter(
      ref,
      baseSequence,
    );
    await this.replayRevisions({ ref, repoPath, revisions, parentSha: base });
    return { baseSequence, replayed: revisions.length };
  }

  private async replayRevisions(params: {
    ref: MarketplaceRepoRef;
    repoPath: string;
    revisions: SkillShareLinkRevision[];
    parentSha: string | null;
  }): Promise<void> {
    const { ref, repoPath } = params;
    let parentSha = params.parentSha;
    for (const rev of params.revisions) {
      const sha = await this.commitOnDisk({
        repoPath,
        files: rev.payload.files,
        parentSha,
        date: rev.createdAt,
        message: formatMessage(rev.sequence, rev.contentHash),
      });
      if (sha !== rev.commitSha) {
        throw new Error(
          `materialize: replay SHA mismatch for ${ref.kind} ${ref.id} sequence ${rev.sequence}: expected ${rev.commitSha}, got ${sha}`,
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
    // one update-index per mode, paths over stdin: a per-file spawn rewrites
    // the whole index each time, so cost grew quadratically with file count
    for (const executable of [true, false]) {
      const paths = params.files
        .filter((file) => (file.mode === "100755") === executable)
        .map((file) => file.path);
      if (paths.length === 0) continue;
      await runGit({
        binary: this.gitBinaryPath,
        cwd: params.repoPath,
        args: [
          "update-index",
          executable ? "--chmod=+x" : "--chmod=-x",
          "-z",
          "--stdin",
        ],
        input: `${paths.join("\0")}\0`,
      });
    }
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

function logReplay(params: {
  ref: MarketplaceRepoRef;
  mode: "incremental" | "full";
  baseSequence: number;
  replayed: number;
  startedAt: number;
  fallbackReason?: string;
  level?: "info" | "warn";
}): void {
  logger[params.level ?? "info"](
    {
      refKind: params.ref.kind,
      refId: params.ref.id,
      mode: params.mode,
      baseSequence: params.baseSequence,
      replayedRevisions: params.replayed,
      durationMs: Date.now() - params.startedAt,
      fallbackReason: params.fallbackReason,
    },
    "[SkillMarketplace] Replayed revisions onto the on-disk repo",
  );
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
  input?: string;
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
    proc.stdin?.end(params.input);
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
