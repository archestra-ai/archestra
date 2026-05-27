import {
  checkDaggerSession,
  type ReplayCommand,
  type RunSandboxCommandInput,
  type SnapshotFile,
  readSandboxArtifact,
  runSandboxCommand,
} from "@archestra/sandbox-rs";
import {
  context as otelContext,
  propagation as otelPropagation,
} from "@opentelemetry/api";
import config from "@/config";
import logger from "@/logging";
import {
  SkillSandboxArtifactModel,
  SkillSandboxCommandModel,
  SkillSandboxFileSnapshotModel,
  SkillSandboxModel,
} from "@/models";
import type { SkillSandbox } from "@/types";
import { asSandboxId, type SandboxId } from "@/types";
import {
  SKILL_SANDBOX_APT_PACKAGES,
  SKILL_SANDBOX_HOME,
  SKILL_SANDBOX_ROOT,
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
  private initPromise: Promise<void> | null = null;
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
        const sandboxInput = await this.buildSandboxInput(sandbox);
        const executed = await runSandboxCommand({
          ...sandboxInput,
          traceparent: getTraceparent(),
          command: params.command,
          cwd,
          timeoutSeconds,
        });
        const durationMs = executed.durationMs || Date.now() - startedAt;

        let row: Awaited<ReturnType<typeof SkillSandboxCommandModel.append>>;
        try {
          row = await SkillSandboxCommandModel.append({
            sandboxId: params.sandboxId,
            command: params.command,
            cwd: params.cwd ?? null,
            stdout: executed.stdout,
            stderr: executed.stderr,
            exitCode: executed.exitCode,
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
          stdout: executed.stdout,
          stderr: executed.stderr,
          exitCode: executed.exitCode,
          durationMs,
          timedOut: executed.timedOut,
          truncated: executed.truncated,
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
        const sandboxInput = await this.buildSandboxInput(sandbox);
        const artifact = await readSandboxArtifact({
          ...sandboxInput,
          traceparent: getTraceparent(),
          path: resolvedPath,
        });
        const data = Buffer.from(artifact.dataBase64, "base64");

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

  private async buildSandboxInput(
    sandbox: SkillSandbox,
  ): Promise<
    Omit<
      RunSandboxCommandInput,
      "command" | "cwd" | "timeoutSeconds" | "traceparent"
    >
  > {
    const snapshots = await SkillSandboxFileSnapshotModel.listBySandbox(
      sandbox.id,
    );
    if (snapshots.length === 0) {
      throw new SkillSandboxError(
        `sandbox ${sandbox.id} has no file snapshots — recreate the sandbox`,
      );
    }
    const log = await SkillSandboxCommandModel.listBySandbox(sandbox.id);
    return {
      image: sandbox.baseImage,
      defaultCwd: sandbox.defaultCwd,
      aptPackages: [...SKILL_SANDBOX_APT_PACKAGES],
      snapshots: snapshots.map(
        (snapshot): SnapshotFile => ({
          skillName: snapshot.skillName,
          path: snapshot.path,
          encoding: snapshot.encoding,
          content: snapshot.content,
        }),
      ),
      replayCommands: log.map(
        (entry): ReplayCommand => ({
          command: entry.command,
          cwd: entry.cwd ?? undefined,
          timeoutSeconds: entry.timeoutSeconds,
        }),
      ),
      limits: {
        outputBytesLimit: config.skillsSandbox.outputBytesLimit,
        fileSizeLimitBytes: config.skillsSandbox.artifactBytesLimit,
        cpuSeconds: config.skillsSandbox.cpuLimit,
        memoryBytes: config.skillsSandbox.memoryLimit,
        maxProcesses: SKILL_SANDBOX_LIMITS.maxProcesses,
      },
    };
  }

  private async doInit(): Promise<void> {
    if (!config.skillsSandbox.enabled) {
      this.status = "disabled";
      return;
    }
    this.applyDaggerEnv();
    this.lastInitAttemptAt = Date.now();
    this.status = "initializing";

    try {
      await checkDaggerSession({ traceparent: getTraceparent() });
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

    const nativeError = getNativeSandboxError(error);
    switch (nativeError.code) {
      case "ARCHESTRA_ARTIFACT_NOT_FOUND":
      case "ARCHESTRA_ARTIFACT_TOO_LARGE":
      case "ARCHESTRA_INVALID_INPUT":
        return new SkillSandboxError(nativeError.message);
      case "ARCHESTRA_ENGINE_UNREACHABLE":
      case "ARCHESTRA_INTERNAL":
      case null:
        this.status = "error";
        logger.error(
          { err: error, code: nativeError.code },
          "[SkillSandboxRuntime] Dagger execution failed",
        );
        return new SkillSandboxError(
          "the skill sandbox runtime is not available (engine unreachable)",
        );
    }
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

const INIT_RETRY_COOLDOWN_MS = 10_000;

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

function getTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  otelPropagation.inject(otelContext.active(), carrier);
  return carrier.traceparent;
}

function getNativeSandboxError(error: unknown): {
  code:
    | "ARCHESTRA_ARTIFACT_NOT_FOUND"
    | "ARCHESTRA_ARTIFACT_TOO_LARGE"
    | "ARCHESTRA_ENGINE_UNREACHABLE"
    | "ARCHESTRA_INTERNAL"
    | "ARCHESTRA_INVALID_INPUT"
    | null;
  message: string;
} {
  if (!(error instanceof Error)) {
    return { code: null, message: String(error) };
  }
  const code =
    typeof (error as Error & { code?: unknown }).code === "string"
      ? (error as Error & { code: string }).code
      : null;

  switch (code) {
    case "ARCHESTRA_ARTIFACT_NOT_FOUND":
    case "ARCHESTRA_ARTIFACT_TOO_LARGE":
    case "ARCHESTRA_ENGINE_UNREACHABLE":
    case "ARCHESTRA_INTERNAL":
    case "ARCHESTRA_INVALID_INPUT":
      return { code, message: error.message };
    default:
      return { code: null, message: error.message };
  }
}

/** @public — exported for tests */
export const __internals = {
  resolveArtifactPath,
  asSandboxId,
};
