import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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
  ReplayRevision,
  RevisionHead,
  RevisionPayloadFile,
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
 * How many first-parent disk commits to search for a stored base. A replica
 * that is merely behind matches at HEAD; a lost append race leaves one orphan
 * on top. Anything deeper falls back to a full rebuild.
 */
const INCREMENTAL_BASE_SEARCH_DEPTH = 8;

/** Revisions per payload query while replaying, so a rebuild never holds them all. */
const REPLAY_PAGE_SIZE = 50;

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

    let latest = await SkillShareLinkRevisionModel.getLatestHead(req.ref);

    for (let attempt = 0; ; attempt++) {
      const currentSequence = latest?.sequence ?? 0;
      const currentFiles = computeLayout(req, currentSequence);
      const currentContentHash = computeContentHash(currentFiles);

      if (latest && latest.contentHash === currentContentHash) {
        await this.syncDiskToRevisions(req.ref, latest);
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
      await this.syncDiskToRevisions(req.ref, latest);

      const createdAt = roundToSeconds(new Date());
      const marks = await this.importRevisions({
        repoPath,
        parentSha: latest?.commitSha ?? null,
        pages: [[{ sequence, contentHash, createdAt, payload: { files } }]],
      });
      const commitSha = marks.get(sequence);
      if (!commitSha) {
        throw new Error(
          `materialize: git fast-import wrote no commit for ${req.ref.kind} ${req.ref.id} sequence ${sequence}`,
        );
      }

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
        latest = await SkillShareLinkRevisionModel.getLatestHead(req.ref);
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
    expectedHead: RevisionHead | null,
  ): Promise<void> {
    const repoPath = this.repoPathFor(ref);

    // every git request of a clone lands here; load revision payloads only
    // when the disk actually needs a replay
    const diskHead = await this.readDiskHead(repoPath);
    if (diskHead === (expectedHead?.commitSha ?? null)) {
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

    await fs.rm(repoPath, { recursive: true, force: true });
    await this.initEmptyRepo(repoPath);
    const replayed = await this.replayRevisions({
      ref,
      repoPath,
      afterSequence: 0,
      parentSha: null,
    });
    logReplay({
      ref,
      mode: "full",
      baseSequence: 0,
      replayed,
      startedAt,
      fallbackReason,
      level: incrementalFailed ? "warn" : "info",
    });
  }

  /**
   * Commit SHAs are deterministic over the whole parent chain, so a disk commit
   * equal to the stored `commitSha` at its sequence proves the disk history up
   * to it matches the stored chain. Rewind `main` to the newest such commit
   * (HEAD itself when this replica is merely behind; its parent when a lost
   * append left an orphan) and replay only the newer revisions. Our commit
   * subjects (`Snapshot <n>`) only choose which stored rows to compare against;
   * SHA equality stays the proof. Returns a reason string when the disk can't
   * be caught up this way and the caller should rebuild from scratch.
   */
  private async replayIncremental(params: {
    ref: MarketplaceRepoRef;
    repoPath: string;
    expectedHead: RevisionHead;
  }): Promise<{ baseSequence: number; replayed: number } | string> {
    const { ref, repoPath, expectedHead } = params;
    const recent = await runGit({
      binary: this.gitBinaryPath,
      cwd: repoPath,
      args: [
        "log",
        "--first-parent",
        `--max-count=${INCREMENTAL_BASE_SEARCH_DEPTH}`,
        "--format=%H%x09%s",
        "HEAD",
      ],
    });
    const candidates = recent.stdout
      .split("\n")
      .map(parseSnapshotLine)
      .filter(
        (line): line is { sha: string; sequence: number } =>
          line !== null && line.sequence <= expectedHead.sequence,
      );
    const stored = new Map(
      (
        await SkillShareLinkRevisionModel.listCommitShas(ref, [
          ...new Set(candidates.map((line) => line.sequence)),
        ])
      ).map((rev) => [rev.sequence, rev.commitSha]),
    );
    const base = candidates.find(
      (line) => stored.get(line.sequence) === line.sha,
    );
    if (!base) return "no stored commit in the recent disk history";

    await runGit({
      binary: this.gitBinaryPath,
      cwd: repoPath,
      args: ["update-ref", "refs/heads/main", base.sha],
    });
    const replayed = await this.replayRevisions({
      ref,
      repoPath,
      afterSequence: base.sequence,
      parentSha: base.sha,
    });
    return { baseSequence: base.sequence, replayed };
  }

  /**
   * Replays the stored revisions after `afterSequence` on top of `parentSha`,
   * a page at a time, and checks every resulting commit against its stored
   * SHA. Returns how many revisions were replayed.
   */
  private async replayRevisions(params: {
    ref: MarketplaceRepoRef;
    repoPath: string;
    afterSequence: number;
    parentSha: string | null;
  }): Promise<number> {
    const { ref } = params;
    const expected: Array<{ sequence: number; commitSha: string }> = [];
    const marks = await this.importRevisions({
      repoPath: params.repoPath,
      parentSha: params.parentSha,
      pages: recordStoredShas(
        revisionPages(ref, params.afterSequence),
        expected,
      ),
    });
    for (const rev of expected) {
      const sha = marks.get(rev.sequence);
      if (sha !== rev.commitSha) {
        throw new Error(
          `materialize: replay SHA mismatch for ${ref.kind} ${ref.id} sequence ${rev.sequence}: expected ${rev.commitSha}, got ${sha}`,
        );
      }
    }
    return expected.length;
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
  }

  /**
   * Writes one commit per revision onto `refs/heads/main` with a single
   * `git fast-import`, streaming file contents without touching the working
   * tree. The first commit lists every file (`deleteall` + `M`); later ones
   * only what changed from the previous revision. Commit bytes match what the
   * earlier write-tree/commit-tree writer produced, so SHAs stay identical.
   * Returns sequence → commit SHA from the exported marks.
   */
  private async importRevisions(params: {
    repoPath: string;
    parentSha: string | null;
    pages: Iterable<ImportRevision[]> | AsyncIterable<ImportRevision[]>;
  }): Promise<Map<number, string>> {
    const marksPath = path.join(params.repoPath, ".git", "fast-import-marks");
    const importer = new FastImportWriter({
      binary: this.gitBinaryPath,
      cwd: params.repoPath,
      args: [
        "fast-import",
        "--quiet",
        // match the old unconditional update-ref: main moves to the replayed tip
        "--force",
        "--date-format=raw",
        `--export-marks=${marksPath}`,
      ],
    });
    const who = `${this.identity.name} <${this.identity.email}>`;

    try {
      await importer.write("feature done\n");
      let previous: Map<string, RevisionPayloadFile> | null = null;
      for await (const page of params.pages) {
        for (const rev of page) {
          const date = toGitDate(rev.createdAt);
          await importer.write(
            `commit refs/heads/main\nmark :${rev.sequence}\nauthor ${who} ${date}\ncommitter ${who} ${date}\n`,
          );
          await importer.writeData(
            Buffer.from(formatMessage(rev.sequence, rev.contentHash), "utf8"),
          );
          if (previous === null) {
            // later commits in this stream continue from the previous commit
            // on refs/heads/main, so only the first one names its parent
            if (params.parentSha) {
              await importer.write(`from ${params.parentSha}\n`);
            }
            await importer.write("deleteall\n");
          }

          const current = new Map(
            rev.payload.files.map((file) => [file.path, file]),
          );
          for (const file of current.values()) {
            const before = previous?.get(file.path);
            if (
              before &&
              before.mode === file.mode &&
              before.encoding === file.encoding &&
              before.content === file.content
            ) {
              continue;
            }
            await importer.write(
              `M ${file.mode} inline ${quoteFastImportPath(file.path)}\n`,
            );
            await importer.writeData(fileBytes(file));
          }
          for (const filePath of previous?.keys() ?? []) {
            if (!current.has(filePath)) {
              await importer.write(`D ${quoteFastImportPath(filePath)}\n`);
            }
          }
          await importer.write("\n");
          previous = current;
        }
      }
      await importer.write("done\n");
      await importer.finish();
    } catch (error) {
      importer.kill();
      throw error;
    }

    let exported = "";
    try {
      exported = await fs.readFile(marksPath, "utf8");
    } catch (error) {
      // no commits, no marks file
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rm(marksPath, { force: true });
    const marks = new Map<number, string>();
    for (const line of exported.split("\n")) {
      // object ids are 40 hex digits (SHA-1) or 64 (SHA-256 repos)
      const match = /^:(\d+) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(line.trim());
      if (match) marks.set(Number(match[1]), match[2]);
    }
    return marks;
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

/** `<sha>\t<subject>` from `git log`, where the subject is ours (`formatMessage`). */
function parseSnapshotLine(
  line: string,
): { sha: string; sequence: number } | null {
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\tSnapshot (\d+)$/.exec(
    line.trim(),
  );
  return match ? { sha: match[1], sequence: Number(match[2]) } : null;
}

type ImportRevision = Pick<
  ReplayRevision,
  "sequence" | "contentHash" | "createdAt" | "payload"
>;

async function* revisionPages(
  ref: MarketplaceRepoRef,
  afterSequence: number,
): AsyncGenerator<ReplayRevision[]> {
  let last = afterSequence;
  for (;;) {
    const page = await SkillShareLinkRevisionModel.listAfter(
      ref,
      last,
      REPLAY_PAGE_SIZE,
    );
    if (page.length > 0) yield page;
    if (page.length < REPLAY_PAGE_SIZE) return;
    last = page[page.length - 1].sequence;
  }
}

/** Passes pages through, noting each revision's stored SHA for the check after import. */
async function* recordStoredShas(
  pages: AsyncIterable<ReplayRevision[]>,
  expected: Array<{ sequence: number; commitSha: string }>,
): AsyncGenerator<ReplayRevision[]> {
  for await (const page of pages) {
    for (const rev of page) {
      expected.push({ sequence: rev.sequence, commitSha: rev.commitSha });
    }
    yield page;
  }
}

function fileBytes(file: RevisionPayloadFile): Buffer {
  return file.encoding === "base64"
    ? Buffer.from(file.content, "base64")
    : Buffer.from(file.content, "utf8");
}

/**
 * fast-import takes a path verbatim to the end of the line unless it starts
 * with a quote; C-style quote anything with a quote, backslash, control or
 * non-ASCII byte so it round-trips exactly.
 */
function quoteFastImportPath(filePath: string): string {
  const bytes = Buffer.from(filePath, "utf8");
  if (!bytes.some((b) => b < 0x20 || b >= 0x7f || b === 0x22 || b === 0x5c)) {
    return filePath;
  }
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    else if (b === 0x0a) out += "\\n";
    else if (b < 0x20 || b >= 0x7f)
      out += `\\${b.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(b);
  }
  return `${out}"`;
}

/** A `git fast-import` child fed with backpressure; binary-safe. */
class FastImportWriter {
  private readonly proc: ChildProcess;
  private readonly exited: Promise<void>;
  private stderr = "";

  constructor(params: { binary: string; cwd: string; args: string[] }) {
    this.proc = spawn(params.binary, params.args, {
      cwd: params.cwd,
      env: scrubGitEnv(process.env),
      stdio: ["pipe", "ignore", "pipe"],
    });
    this.proc.stderr?.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    // a git that dies mid-stream closes stdin under us; report its exit
    // status from `exited` rather than an EPIPE
    this.proc.stdin?.on("error", () => undefined);
    this.exited = new Promise((resolve, reject) => {
      this.proc.once("error", reject);
      this.proc.once("close", (code, signal) => {
        if (signal) {
          reject(
            new Error(
              `git fast-import terminated by signal ${signal}: ${this.stderr.trim()}`,
            ),
          );
        } else if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `git fast-import exited with code ${code}: ${this.stderr.trim()}`,
            ),
          );
        }
      });
    });
    // observed through write()/finish(); avoid an unhandled rejection meanwhile
    this.exited.catch(() => undefined);
  }

  async write(chunk: string | Buffer): Promise<void> {
    const stdin = this.proc.stdin;
    if (!stdin || this.proc.exitCode !== null || this.proc.signalCode) {
      await this.exited;
      throw new Error(`git fast-import exited early: ${this.stderr.trim()}`);
    }
    if (stdin.write(chunk)) return;
    await Promise.race([once(stdin, "drain"), this.exited]);
    // `exited` wins the race when git stops reading and exits 0; the rest of
    // the stream would go nowhere
    if (this.proc.exitCode !== null || this.proc.signalCode) {
      throw new Error(`git fast-import exited early: ${this.stderr.trim()}`);
    }
  }

  /** `data <n>` + the exact bytes + LF. */
  async writeData(bytes: Buffer): Promise<void> {
    await this.write(`data ${bytes.length}\n`);
    await this.write(bytes);
    await this.write("\n");
  }

  async finish(): Promise<void> {
    this.proc.stdin?.end();
    await this.exited;
  }

  kill(): void {
    if (this.proc.exitCode === null) this.proc.kill();
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
}

function runGit(
  params: RunGitParams,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(params.binary, params.args, {
      cwd: params.cwd,
      // strip host GIT_* env so e.g. an operator-set GIT_DIR or
      // GIT_AUTHOR_DATE can't divert commits or break replay determinism
      env: scrubGitEnv(process.env),
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
    proc.stdin?.end();
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
