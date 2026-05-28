import type { ReplayCommand, SnapshotFile } from "@archestra/sandbox-rs";
import config from "@/config";
import {
  DaggerRuntimeError,
  daggerRuntimeService,
} from "@/dagger-runtime/dagger-runtime-service";
import logger from "@/logging";
import {
  SkillSandboxArtifactModel,
  SkillSandboxCommandModel,
  SkillSandboxFileSnapshotModel,
  SkillSandboxModel,
} from "@/models";
import type { SkillSandbox } from "@/types";
import { asSandboxId, type SandboxId } from "@/types";
import { SKILL_SANDBOX_HOME, SKILL_SANDBOX_ROOT } from "./runtime-image";
import {
  type ArtifactRef,
  type CommandResult,
  type ExportArtifactParams,
  type RunCommandParams,
  SKILL_SANDBOX_LIMITS,
  SkillSandboxError,
} from "./types";

/**
 * Orchestrates DB-backed skill sandboxes: loads snapshots + replay log,
 * delegates execution to the unified `daggerRuntimeService`, appends the
 * result to the command log.
 *
 * Per-sandbox serialization is enforced here (not in the runtime service) so
 * concurrent calls cannot observe stale replay state or record commands out of
 * execution order.
 */
class SkillSandboxRuntimeService {
  // per-sandbox promise chain: ensures load + exec + append are atomic per sandbox.
  private readonly sandboxQueues = new Map<string, Promise<unknown>>();
  // per-sandbox pending counter for queue capacity enforcement.
  private readonly sandboxPendingCounts = new Map<string, number>();

  get isEnabled(): boolean {
    return config.skillsSandbox.enabled && daggerRuntimeService.isEnabled;
  }

  get isReady(): boolean {
    return daggerRuntimeService.isReady;
  }

  async init(): Promise<void> {
    if (!config.skillsSandbox.enabled) return;
    await daggerRuntimeService.init();
  }

  async shutdown(): Promise<void> {
    await daggerRuntimeService.shutdown();
  }

  async runCommand(params: RunCommandParams): Promise<CommandResult> {
    this.ensureEnabled();
    validateCommand(params.command);
    const timeoutSeconds = this.resolveTimeout(params.timeoutSeconds);

    return this.runExclusive(params.sandboxId, async () => {
      const sandbox = await this.loadSandbox(params.sandboxId);
      const cwd = params.cwd ?? sandbox.defaultCwd;
      const { snapshots, replayCommands } = await this.buildContext(sandbox);

      let executed: Awaited<ReturnType<typeof daggerRuntimeService.runCommand>>;
      try {
        executed = await daggerRuntimeService.runCommand({
          command: params.command,
          cwd,
          timeoutSeconds,
          snapshots,
          replayCommands,
          outputBytesLimit: config.skillsSandbox.outputBytesLimit,
          fileSizeLimitBytes: config.skillsSandbox.artifactBytesLimit,
        });
      } catch (error) {
        throw this.toSkillError(error);
      }

      let row: Awaited<ReturnType<typeof SkillSandboxCommandModel.append>>;
      try {
        row = await SkillSandboxCommandModel.append({
          sandboxId: params.sandboxId,
          command: params.command,
          cwd: params.cwd ?? null,
          stdout: executed.stdout,
          stderr: executed.stderr,
          exitCode: executed.exitCode,
          durationMs: executed.durationMs,
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
        durationMs: executed.durationMs,
        timedOut: executed.timedOut,
        truncated: executed.truncated,
      };
    });
  }

  async exportArtifact(params: ExportArtifactParams): Promise<ArtifactRef> {
    this.ensureEnabled();

    return this.runExclusive(params.sandboxId, async () => {
      const sandbox = await this.loadSandbox(params.sandboxId);
      const resolvedPath = resolveArtifactPath({
        path: params.path,
        defaultCwd: sandbox.defaultCwd,
      });
      const { snapshots, replayCommands } = await this.buildContext(sandbox);

      let artifact: Awaited<
        ReturnType<typeof daggerRuntimeService.readArtifact>
      >;
      try {
        artifact = await daggerRuntimeService.readArtifact({
          snapshots,
          replayCommands,
          path: resolvedPath,
          fileSizeLimitBytes: config.skillsSandbox.artifactBytesLimit,
        });
      } catch (error) {
        throw this.toSkillError(error);
      }

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
    });
  }

  // === private ===

  private ensureEnabled(): void {
    if (!this.isEnabled) {
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

  private async buildContext(sandbox: SkillSandbox): Promise<{
    snapshots: SnapshotFile[];
    replayCommands: ReplayCommand[];
  }> {
    const snapshotRows = await SkillSandboxFileSnapshotModel.listBySandbox(
      sandbox.id,
    );
    if (snapshotRows.length === 0) {
      throw new SkillSandboxError(
        `sandbox ${sandbox.id} has no file snapshots — recreate the sandbox`,
      );
    }
    const log = await SkillSandboxCommandModel.listBySandbox(sandbox.id);
    return {
      snapshots: snapshotRows.map(
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
    };
  }

  private toSkillError(error: unknown): SkillSandboxError {
    if (error instanceof SkillSandboxError) return error;
    if (error instanceof DaggerRuntimeError) {
      switch (error.code) {
        case "ARCHESTRA_ARTIFACT_NOT_FOUND":
        case "ARCHESTRA_ARTIFACT_TOO_LARGE":
        case "ARCHESTRA_INVALID_INPUT":
          return new SkillSandboxError(error.message);
        case "ARCHESTRA_ENGINE_UNREACHABLE":
        case "ARCHESTRA_INTERNAL":
          logger.error({ err: error }, "[SkillSandbox] runtime error");
          return new SkillSandboxError(
            "the skill sandbox runtime is not available (engine unreachable)",
          );
      }
    }
    logger.error({ err: error }, "[SkillSandbox] unexpected error");
    return new SkillSandboxError(
      "the skill sandbox runtime is not available (engine unreachable)",
    );
  }

  /**
   * Serializes operations on the same sandbox so concurrent calls observe a
   * consistent replay state. Also enforces a per-sandbox queue cap.
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
    const next = prev.then(
      () => fn(),
      () => fn(),
    );
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
}

export const skillSandboxRuntimeService = new SkillSandboxRuntimeService();

// === internal helpers ===

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

/** @public — exported for tests */
export const __internals = {
  resolveArtifactPath,
  asSandboxId,
};
