import {
  type Client,
  type ConnectOpts,
  type Container,
  connect,
  ReturnType as DaggerReturnType,
} from "@dagger.io/dagger";
import config from "@/config";
import logger from "@/logging";
import {
  SkillSandboxArtifactModel,
  SkillSandboxCommandModel,
  SkillSandboxFileSnapshotModel,
  SkillSandboxModel,
} from "@/models";
import type { SkillSandbox, SkillSandboxFileSnapshot } from "@/types";
import { asSandboxId, type SandboxId } from "@/types";
import {
  SKILL_SANDBOX_APT_PACKAGES,
  SKILL_SANDBOX_HOME,
  SKILL_SANDBOX_ROOT,
  SKILL_SANDBOX_USER,
  skillRootPath,
} from "./runtime-image";
import {
  type ArtifactRef,
  type CommandResult,
  type ExportArtifactParams,
  type RunCommandParams,
  SKILL_SANDBOX_LIMITS,
  SkillSandboxError,
  type SkillSandboxStatus,
} from "./types";

/**
 * Materializes a DB-backed skill sandbox into a fresh Dagger container, runs
 * shell commands against it, and exports generated files as artifacts.
 *
 * Each `runCommand` materializes the sandbox from scratch and replays the full
 * persisted command log so the new command sees a coherent state. Dagger's
 * layer cache makes repeat replays cheap; on a cold cache the replay is slower
 * but still correct.
 */
class SkillSandboxRuntimeService {
  private status: SkillSandboxStatus = "disabled";
  private client: Client | null = null;
  private initPromise: Promise<void> | null = null;
  private sessionPromise: Promise<void> | null = null;
  private stopSession: (() => void) | null = null;
  private lastInitAttemptAt = 0;
  private activeRuns = 0;
  private readonly waiters: Array<() => void> = [];
  // per-sandbox promise chain: ensures replay + exec + append are atomic per sandbox
  private readonly sandboxQueues = new Map<string, Promise<unknown>>();
  // tracks how many requests are in-flight or waiting per sandbox for capacity enforcement
  private readonly sandboxPendingCounts = new Map<string, number>();

  get isEnabled(): boolean {
    return config.skillsSandbox.enabled;
  }

  get isReady(): boolean {
    return this.status === "ready";
  }

  init(): Promise<void> {
    if (!config.skillsSandbox.enabled) {
      this.status = "disabled";
      return Promise.resolve();
    }
    if (this.status === "ready" || this.status === "stopped") {
      return Promise.resolve();
    }
    if (this.initPromise) return this.initPromise;

    const now = Date.now();
    if (
      this.status === "error" &&
      now - this.lastInitAttemptAt < INIT_RETRY_COOLDOWN_MS
    ) {
      return Promise.resolve();
    }

    this.initPromise = this.doInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  /**
   * Materializes the sandbox, replays the persisted command log into a fresh
   * container, runs the new command, and appends the result to the log.
   */
  async runCommand(params: RunCommandParams): Promise<CommandResult> {
    this.ensureEnabled();
    validateCommand(params.command);
    const timeoutSeconds = this.resolveTimeout(params.timeoutSeconds);

    // runExclusive is called synchronously (before the first await in this
    // async function) so the per-sandbox queue limit is enforced immediately;
    // async setup (loadSandbox, init) happens inside the exclusive callback.
    return this.runExclusive(params.sandboxId, async () => {
      const sandbox = await this.loadSandbox(params.sandboxId);
      const cwd = params.cwd ?? sandbox.defaultCwd;

      await this.init();
      if (this.status !== "ready") {
        throw new SkillSandboxError(
          "the skill sandbox runtime is not available (engine unreachable)",
        );
      }

      await this.acquire();
      const startedAt = Date.now();
      try {
        const client = this.client;
        if (!client) {
          this.status = "error";
          throw new SkillSandboxError(
            "the skill sandbox runtime is not available (engine unreachable)",
          );
        }

        const materialized = await this.materializeWithReplay({
          client,
          sandbox,
        });
        const wrapped = wrapWithTimeout({
          command: params.command,
          cwd,
          timeoutSeconds,
          outputBytesLimit: config.skillsSandbox.outputBytesLimit,
          fileSizeLimitBytes: config.skillsSandbox.artifactBytesLimit,
          cpuSeconds: config.skillsSandbox.cpuLimit,
          memoryBytes: config.skillsSandbox.memoryLimit,
          maxProcesses: SKILL_SANDBOX_LIMITS.maxProcesses,
        });
        const executed = materialized.withExec(["bash", "-c", wrapped], {
          expect: DaggerReturnType.Any,
        });
        const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
          executed.stdout(),
          executed.stderr(),
          executed.exitCode(),
        ]);
        const stdout = truncateOutput(
          stdoutRaw,
          config.skillsSandbox.outputBytesLimit,
        );
        const stderr = truncateOutput(
          stderrRaw,
          config.skillsSandbox.outputBytesLimit,
        );
        const durationMs = Date.now() - startedAt;
        const timedOut = exitCode === TIMEOUT_EXIT_CODE;

        let row: Awaited<ReturnType<typeof SkillSandboxCommandModel.append>>;
        try {
          row = await SkillSandboxCommandModel.append({
            sandboxId: params.sandboxId,
            command: params.command,
            cwd: params.cwd ?? null,
            stdout: stdout.value,
            stderr: stderr.value,
            exitCode,
            durationMs,
            timeoutSeconds,
          });
        } catch (dbError) {
          throw new SkillSandboxError(
            `failed to persist command result: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
          );
        }

        return {
          commandId: row.id,
          sandboxId: params.sandboxId,
          command: params.command,
          cwd: params.cwd ?? null,
          stdout: stdout.value,
          stderr: stderr.value,
          exitCode,
          durationMs,
          timedOut,
          truncated: stdout.truncated || stderr.truncated,
        };
      } catch (error) {
        throw await this.normalizeError(error);
      } finally {
        this.release();
      }
    });
  }

  /**
   * Materializes the sandbox, replays the command log, reads the requested
   * file as bytes, and persists it to `skill_sandbox_artifacts`.
   */
  async exportArtifact(params: ExportArtifactParams): Promise<ArtifactRef> {
    this.ensureEnabled();

    // runExclusive is called synchronously (before the first await in this
    // async function) so the per-sandbox queue limit is enforced immediately;
    // async setup (loadSandbox, init) happens inside the exclusive callback.
    return this.runExclusive(params.sandboxId, async () => {
      const sandbox = await this.loadSandbox(params.sandboxId);
      const resolvedPath = resolveArtifactPath({
        path: params.path,
        defaultCwd: sandbox.defaultCwd,
      });

      await this.init();
      if (this.status !== "ready") {
        throw new SkillSandboxError(
          "the skill sandbox runtime is not available (engine unreachable)",
        );
      }

      await this.acquire();
      try {
        const client = this.client;
        if (!client) {
          this.status = "error";
          throw new SkillSandboxError(
            "the skill sandbox runtime is not available (engine unreachable)",
          );
        }

        const materialized = await this.materializeWithReplay({
          client,
          sandbox,
        });
        // `base64 -w0` collapses the file into one line for clean capture; this
        // works for binary contents that `.file(...).contents()` cannot expose
        // directly because the Dagger File API returns strings only.
        // stat the file first so we reject oversized artifacts before transferring
        // their full contents across the Dagger boundary (avoids OOM on large files)
        const bytesLimit = config.skillsSandbox.artifactBytesLimit;
        const encoder = materialized.withExec(
          [
            "bash",
            "-c",
            `_s=$(stat -c '%s' ${shellQuote(resolvedPath)}) && ` +
              `[ "$_s" -le ${bytesLimit} ] || ` +
              `{ echo "artifact is too large ($_s bytes > ${bytesLimit})" >&2; exit 1; }; ` +
              `base64 -w0 ${shellQuote(resolvedPath)}`,
          ],
          { expect: DaggerReturnType.Any },
        );
        const [base64Stdout, exitCode, stderr] = await Promise.all([
          encoder.stdout(),
          encoder.exitCode(),
          encoder.stderr(),
        ]);
        if (exitCode !== 0) {
          throw new SkillSandboxError(
            `failed to read artifact at ${resolvedPath}: ${stderr.trim() || `exit ${exitCode}`}`,
          );
        }
        const data = Buffer.from(base64Stdout.trim(), "base64");

        let row: Awaited<ReturnType<typeof SkillSandboxArtifactModel.create>>;
        try {
          row = await SkillSandboxArtifactModel.create({
            sandboxId: params.sandboxId,
            path: resolvedPath,
            mimeType: params.mimeType ?? "application/octet-stream",
            sizeBytes: data.byteLength,
            data,
          });
        } catch (dbError) {
          throw new SkillSandboxError(
            `failed to persist artifact: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
          );
        }

        return {
          artifactId: row.id,
          sandboxId: params.sandboxId,
          path: row.path,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
        };
      } catch (error) {
        throw await this.normalizeError(error);
      } finally {
        this.release();
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.status !== "disabled") {
      this.status = "stopped";
    }
    await this.closeDaggerSession();
  }

  // === private ===

  private ensureEnabled(): void {
    if (!config.skillsSandbox.enabled) {
      throw new SkillSandboxError("the skill sandbox runtime is not enabled");
    }
  }

  private async loadSandbox(sandboxId: SandboxId): Promise<SkillSandbox> {
    const sandbox = await SkillSandboxModel.findById(sandboxId);
    if (!sandbox) {
      throw new SkillSandboxError(`sandbox ${sandboxId} does not exist`);
    }
    return sandbox;
  }

  private resolveTimeout(requested: number | undefined): number {
    const max = config.skillsSandbox.wallClockSeconds;
    if (requested === undefined) return max;
    if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
      throw new SkillSandboxError("timeoutSeconds must be a finite integer");
    }
    if (requested <= 0) {
      throw new SkillSandboxError("timeoutSeconds must be positive");
    }
    return Math.min(requested, max);
  }

  private async materializeWithReplay(params: {
    client: Client;
    sandbox: SkillSandbox;
  }): Promise<Container> {
    const base = await this.materialize(params);
    const log = await SkillSandboxCommandModel.listBySandbox(params.sandbox.id);
    let container = base;
    for (const entry of log) {
      const cwd = entry.cwd ?? params.sandbox.defaultCwd;
      const wrapped = wrapWithTimeout({
        command: entry.command,
        cwd,
        timeoutSeconds: entry.timeoutSeconds,
        outputBytesLimit: config.skillsSandbox.outputBytesLimit,
        fileSizeLimitBytes: config.skillsSandbox.artifactBytesLimit,
        cpuSeconds: config.skillsSandbox.cpuLimit,
        memoryBytes: config.skillsSandbox.memoryLimit,
        maxProcesses: SKILL_SANDBOX_LIMITS.maxProcesses,
      });
      // replays accept any exit code so prior failures do not block the new
      // command; Dagger's layer cache keeps repeat replays fast.
      container = container.withExec(["bash", "-c", wrapped], {
        expect: DaggerReturnType.Any,
      });
    }
    return container;
  }

  private async materialize(params: {
    client: Client;
    sandbox: SkillSandbox;
  }): Promise<Container> {
    const snapshots = await SkillSandboxFileSnapshotModel.listBySandbox(
      params.sandbox.id,
    );
    if (snapshots.length === 0) {
      throw new SkillSandboxError(
        `sandbox ${params.sandbox.id} has no file snapshots — recreate the sandbox`,
      );
    }

    let container = this.buildBaseContainer({
      client: params.client,
      image: params.sandbox.baseImage,
      defaultCwd: params.sandbox.defaultCwd,
    });

    // group snapshots by skillId so all files for one skill share a root path
    const bySkill = new Map<
      string,
      { skillName: string; files: SkillSandboxFileSnapshot[] }
    >();
    for (const snap of snapshots) {
      let entry = bySkill.get(snap.skillId);
      if (!entry) {
        entry = { skillName: snap.skillName, files: [] };
        bySkill.set(snap.skillId, entry);
      }
      entry.files.push(snap);
    }

    for (const { skillName, files } of bySkill.values()) {
      const root = skillRootPath(skillName);
      for (const file of files) {
        container = applySnapshotFile({ container, root, file });
      }
    }

    // withNewFile creates files as root regardless of the container's current
    // user; fix ownership so the sandbox user can write to any snapshot dir
    // (needed for base64-encoded binary assets decoded via withExec).
    container = container
      .withUser("root")
      .withExec([
        "sh",
        "-c",
        `chown -R ${SKILL_SANDBOX_USER} ${SKILL_SANDBOX_ROOT}`,
      ])
      .withUser(SKILL_SANDBOX_USER);

    return container;
  }

  private buildBaseContainer(params: {
    client: Client;
    image: string;
    defaultCwd: string;
  }): Container {
    const packages = SKILL_SANDBOX_APT_PACKAGES.join(" ");
    return (
      params.client
        .container()
        .from(params.image)
        // install baseline toolchain as root before switching to the sandbox user;
        // also create the sandbox home dir so tool caches don't pollute /skills
        .withExec([
          "sh",
          "-c",
          `apt-get update -qq && apt-get install -y --no-install-recommends ${packages} && rm -rf /var/lib/apt/lists/* && mkdir -p ${SKILL_SANDBOX_HOME} ${SKILL_SANDBOX_ROOT} && chown 1000:1000 ${SKILL_SANDBOX_HOME} ${SKILL_SANDBOX_ROOT}`,
        ])
        .withUser(SKILL_SANDBOX_USER)
        .withEnvVariable("HOME", SKILL_SANDBOX_HOME)
        .withEnvVariable("SKILL_SANDBOX_ROOT", SKILL_SANDBOX_ROOT)
        .withWorkdir(params.defaultCwd)
    );
  }

  private async doInit(): Promise<void> {
    if (!config.skillsSandbox.enabled) {
      this.status = "disabled";
      return;
    }
    this.applyDaggerEnv();
    await this.closeDaggerSession();
    this.lastInitAttemptAt = Date.now();
    this.status = "initializing";

    let readySettled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = () => {
        if (readySettled) return;
        readySettled = true;
        resolve();
      };
      rejectReady = (error) => {
        if (readySettled) return;
        readySettled = true;
        reject(error);
      };
    });

    let closeSession!: () => void;
    const sessionClosed = new Promise<void>((resolve) => {
      closeSession = resolve;
    });
    this.stopSession = closeSession;

    const sessionPromise = connect(async (client) => {
      this.client = client;
      try {
        resolveReady();
        await sessionClosed;
      } catch (error) {
        rejectReady(error);
        throw error;
      } finally {
        if (this.client === client) {
          this.client = null;
        }
        if (this.stopSession === closeSession) {
          this.stopSession = null;
        }
      }
    }, DAGGER_CONNECT_OPTS)
      .catch((error) => {
        rejectReady(error);
        if (this.status !== "stopped") {
          this.status = "error";
        }
      })
      .finally(() => {
        if (this.sessionPromise === sessionPromise) {
          this.sessionPromise = null;
        }
        if (this.status === "ready") {
          this.status = "error";
        }
      });
    this.sessionPromise = sessionPromise;

    try {
      await ready;
      this.status = "ready";
      logger.info(
        { image: config.skillsSandbox.image },
        "[SkillSandboxRuntime] ready",
      );
    } catch (error) {
      this.status = "error";
      logger.error(
        { err: error },
        "[SkillSandboxRuntime] failed to initialize — skill execution unavailable",
      );
    }
  }

  private async normalizeError(error: unknown): Promise<SkillSandboxError> {
    if (error instanceof SkillSandboxError) return error;

    this.status = "error";
    await this.closeDaggerSession();
    logger.error(
      { err: error },
      "[SkillSandboxRuntime] Dagger execution failed",
    );
    return new SkillSandboxError(
      "the skill sandbox runtime is not available (engine unreachable)",
    );
  }

  private async closeDaggerSession(): Promise<void> {
    this.client = null;
    this.stopSession?.();
    await this.sessionPromise?.catch((error) => {
      logger.error(
        { err: error },
        "[SkillSandboxRuntime] Dagger session failed",
      );
    });
  }

  private applyDaggerEnv(): void {
    const { daggerRunnerHost, daggerCliBin } = config.skillsSandbox;
    if (daggerRunnerHost) {
      process.env._EXPERIMENTAL_DAGGER_RUNNER_HOST = daggerRunnerHost;
    }
    if (daggerCliBin) {
      process.env._EXPERIMENTAL_DAGGER_CLI_BIN = daggerCliBin;
    }
  }

  /**
   * Serializes operations on the same sandbox: replay + exec + append must be
   * atomic per sandbox so that concurrent calls cannot observe stale replay
   * state or record commands out of execution order.
   *
   * Also enforces a per-sandbox queue cap so a flood of requests for one
   * sandbox cannot create an unbounded promise chain that bypasses the global
   * capacity guard in `acquire()`.
   */
  private runExclusive<T>(sandboxId: string, fn: () => Promise<T>): Promise<T> {
    const pending = this.sandboxPendingCounts.get(sandboxId) ?? 0;
    if (pending >= SKILL_SANDBOX_LIMITS.maxSandboxQueueLength) {
      return Promise.reject(
        new SkillSandboxError(
          "too many requests are already queued for this sandbox",
        ),
      );
    }
    this.sandboxPendingCounts.set(sandboxId, pending + 1);

    const prev = this.sandboxQueues.get(sandboxId) ?? Promise.resolve();
    // chain fn after any in-flight operation; proceed even if prev errored
    const next = prev.then(
      () => fn(),
      () => fn(),
    );
    // decrement the pending count when fn settles (success or failure)
    const counted = next.then(
      (v) => {
        this.decrementSandboxPending(sandboxId);
        return v;
      },
      (e) => {
        this.decrementSandboxPending(sandboxId);
        throw e;
      },
    );
    // store a never-rejecting tail so the next enqueued call can chain safely
    const tail = counted.catch(() => {});
    this.sandboxQueues.set(sandboxId, tail);
    tail.then(() => {
      if (this.sandboxQueues.get(sandboxId) === tail) {
        this.sandboxQueues.delete(sandboxId);
      }
    });
    return counted;
  }

  private decrementSandboxPending(sandboxId: string): void {
    const count = this.sandboxPendingCounts.get(sandboxId) ?? 0;
    if (count <= 1) {
      this.sandboxPendingCounts.delete(sandboxId);
    } else {
      this.sandboxPendingCounts.set(sandboxId, count - 1);
    }
  }

  private async acquire(): Promise<void> {
    if (this.activeRuns < config.skillsSandbox.maxConcurrent) {
      this.activeRuns++;
      return;
    }
    if (this.waiters.length >= SKILL_SANDBOX_LIMITS.maxQueueLength) {
      throw new SkillSandboxError(
        "the skill sandbox runtime is at capacity — too many runs are already queued",
      );
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.activeRuns--;
    }
  }
}

export const skillSandboxRuntimeService = new SkillSandboxRuntimeService();

// === internal helpers ===

/** Synthetic exit code emitted by GNU `timeout` when the wall clock fires. */
const TIMEOUT_EXIT_CODE = 124;
const INIT_RETRY_COOLDOWN_MS = 10_000;
const DAGGER_CONNECT_OPTS = {
  LoadWorkspaceModules: false,
  Workdir: "/",
} satisfies ConnectOpts;

function validateCommand(command: string): void {
  if (!command.trim()) {
    throw new SkillSandboxError("command must be a non-empty string");
  }
  if (
    Buffer.byteLength(command, "utf8") > SKILL_SANDBOX_LIMITS.maxCommandBytes
  ) {
    throw new SkillSandboxError(
      `command is too large (> ${SKILL_SANDBOX_LIMITS.maxCommandBytes} bytes)`,
    );
  }
}

function validateSnapshotFilePath(path: string): void {
  if (path.startsWith("/") || path.split("/").some((s) => s === "..")) {
    throw new SkillSandboxError(
      `invalid snapshot file path: ${JSON.stringify(path)}`,
    );
  }
}

function applySnapshotFile(params: {
  container: Container;
  root: string;
  file: Pick<SkillSandboxFileSnapshot, "path" | "encoding" | "content">;
}): Container {
  validateSnapshotFilePath(params.file.path);
  const target = `${params.root}/${params.file.path}`;
  switch (params.file.encoding) {
    case "utf8":
      return params.container.withNewFile(target, params.file.content);
    case "base64": {
      // Dagger has no direct byte upload — stage the base64 string in a temp
      // file and decode it in-place so binary assets land verbatim.
      const tempPath = `${target}.b64`;
      const parentDir = target.substring(0, target.lastIndexOf("/"));
      return params.container
        .withNewFile(tempPath, params.file.content)
        .withExec([
          "bash",
          "-c",
          `mkdir -p ${shellQuote(parentDir)} && base64 -d ${shellQuote(tempPath)} > ${shellQuote(target)} && rm ${shellQuote(tempPath)}`,
        ]);
    }
  }
}

function wrapWithTimeout(params: {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  outputBytesLimit: number;
  fileSizeLimitBytes: number;
  cpuSeconds: number;
  memoryBytes: number;
  maxProcesses: number;
}): string {
  const cd = `cd ${shellQuote(params.cwd)}`;
  const limit = params.outputBytesLimit;
  // pipe would swallow exit code (head's 0 wins); write to temp files so we
  // can exit with the real code — 124 from timeout or the command's own code.
  // pass limit+1 bytes so truncateOutput can detect truncation (limit alone
  // would always produce bytes <= limit, making the truncated flag unreachable)
  //
  // ulimit -f (512-byte blocks) caps per-file writes so a flood command like
  // `yes` cannot exhaust container storage before the wall clock fires.
  // ulimit -t caps CPU seconds, ulimit -v caps virtual memory (in KB),
  // ulimit -u caps the number of spawnable processes to prevent fork bombs.
  const fileLimitBlocks = Math.ceil(params.fileSizeLimitBytes / 512);
  const memoryKilobytes = Math.ceil(params.memoryBytes / 1024);
  return (
    `${cd} && ` +
    `_d=$(mktemp -d) || { echo 'mktemp failed' >&2; exit 1; }; ` +
    `ulimit -f ${fileLimitBlocks} 2>/dev/null; ` +
    `ulimit -t ${params.cpuSeconds} 2>/dev/null; ` +
    `ulimit -v ${memoryKilobytes} 2>/dev/null; ` +
    `ulimit -u ${params.maxProcesses} 2>/dev/null; ` +
    `timeout --signal=KILL ${params.timeoutSeconds}s bash -c ${shellQuote(params.command)} >"$_d/o" 2>"$_d/e"; ` +
    `_x=$?; ` +
    `head -c ${limit + 1} "$_d/o"; ` +
    `head -c ${limit + 1} "$_d/e" >&2; ` +
    `rm -rf "$_d"; ` +
    `exit $_x`
  );
}

function truncateOutput(
  raw: string,
  limit: number,
): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= limit) {
    return { value: raw, truncated: false };
  }
  // slice by byte boundary, not char index, to enforce the byte cap correctly
  const truncated = Buffer.from(raw, "utf8")
    .subarray(0, limit)
    .toString("utf8");
  return {
    value: `${truncated}\n...[output truncated]`,
    truncated: true,
  };
}

function resolveArtifactPath(params: {
  path: string;
  defaultCwd: string;
}): string {
  if (params.path.includes("\0")) {
    throw new SkillSandboxError(
      `invalid artifact path: ${JSON.stringify(params.path)}`,
    );
  }
  if (params.path.split("/").some((segment) => segment === "..")) {
    throw new SkillSandboxError(
      `invalid artifact path: ${JSON.stringify(params.path)}`,
    );
  }
  if (params.path.startsWith("/")) {
    const allowedRoots = [SKILL_SANDBOX_ROOT, SKILL_SANDBOX_HOME];
    const isAllowed = allowedRoots.some(
      (root) => params.path === root || params.path.startsWith(`${root}/`),
    );
    if (!isAllowed) {
      throw new SkillSandboxError(
        `artifact path must be under ${SKILL_SANDBOX_ROOT} or ${SKILL_SANDBOX_HOME}: ${JSON.stringify(params.path)}`,
      );
    }
    return params.path;
  }
  const cwd = params.defaultCwd.endsWith("/")
    ? params.defaultCwd.slice(0, -1)
    : params.defaultCwd;
  return `${cwd}/${params.path}`;
}

/** Quote a single shell argument with single quotes, escaping embedded quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** @public — exported for tests */
export const __internals = {
  shellQuote,
  truncateOutput,
  resolveArtifactPath,
  validateSnapshotFilePath,
  wrapWithTimeout,
  asSandboxId,
};
