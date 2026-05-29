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
import type { SkillSandbox, SkillSandboxFileSnapshot } from "@/types";
import { asSandboxId, type SandboxId } from "@/types";
import { resolveArtifactMime } from "./mime-sniff";
import {
  SKILL_SANDBOX_HOME,
  SKILL_SANDBOX_ROOT,
  skillRootPath,
} from "./runtime-image";
import {
  type ArtifactRef,
  type CommandResult,
  type ExportArtifactParams,
  type RunCommandParams,
  SKILL_SANDBOX_LIMITS,
  SkillSandboxError,
} from "./types";

const CONSUMER_ID = "skill-sandbox";
// synthetic exit code recorded when the runtime errored mid-call and the real
// exit status was lost. distinct from any value the wrapped bash subprocess
// can produce (which is bounded to 0..255).
const SYNTHETIC_ENGINE_FAILURE_EXIT_CODE = -1;
// must match `DEFAULT_VENV_PYTHON` in archestra-rs/sandbox-core/src/session.rs; we don't
// re-export it from the napi crate to avoid coupling the TS adapter to Rust
// build state.
const VENV_PYTHON = "/home/sandbox/.venv/bin/python";
const REQUIREMENTS_FILE = "requirements.txt";
// covers the cold first install for a typical skill (pillow + a few siblings);
// subsequent calls hit Dagger's layer cache and finish in ms.
const REQUIREMENTS_INSTALL_TIMEOUT_SECONDS = 180;

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
    await daggerRuntimeService.attach(CONSUMER_ID);
  }

  async shutdown(): Promise<void> {
    await daggerRuntimeService.detach(CONSUMER_ID);
  }

  async runCommand(params: RunCommandParams): Promise<CommandResult> {
    this.ensureEnabled();
    validateCommand(params.command);
    const timeoutSeconds = this.resolveTimeout(params.timeoutSeconds);

    return this.runExclusive(params.sandboxId, async () => {
      const sandbox = await this.loadSandbox(params.sandboxId);
      const cwd = params.cwd ?? sandbox.defaultCwd;
      const { snapshots, replayCommands, pythonpath } =
        await this.buildContext(sandbox);

      let executed: Awaited<ReturnType<typeof daggerRuntimeService.runCommand>>;
      try {
        executed = await daggerRuntimeService.runCommand({
          command: params.command,
          cwd,
          timeoutSeconds,
          snapshots,
          replayCommands,
          pythonpath,
          outputBytesLimit: config.skillsSandbox.outputBytesLimit,
          fileSizeLimitBytes: config.skillsSandbox.artifactBytesLimit,
          cpuSeconds: config.skillsSandbox.cpuLimit,
          memoryBytes: config.skillsSandbox.memoryLimit,
        });
      } catch (error) {
        // engine-level failure (unreachable / internal panic) — the command
        // may have already run inside Dagger but we lost the result. Record a
        // synthetic row so subsequent replays re-execute it instead of
        // silently dropping it from the log, then surface the error.
        if (shouldRecordOnFailure(error)) {
          await this.appendSyntheticRow({
            sandboxId: params.sandboxId,
            organizationId: sandbox.organizationId,
            command: params.command,
            cwd: params.cwd ?? null,
            timeoutSeconds,
          });
        }
        throw this.toSkillError(error);
      }

      let row: Awaited<ReturnType<typeof SkillSandboxCommandModel.append>>;
      try {
        row = await SkillSandboxCommandModel.append({
          sandboxId: params.sandboxId,
          organizationId: sandbox.organizationId,
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
      const { snapshots, replayCommands, pythonpath } =
        await this.buildContext(sandbox);

      let artifact: Awaited<
        ReturnType<typeof daggerRuntimeService.readArtifact>
      >;
      try {
        artifact = await daggerRuntimeService.readArtifact({
          snapshots,
          replayCommands,
          path: resolvedPath,
          defaultCwd: sandbox.defaultCwd,
          pythonpath,
          // must match runCommand's limit: the command supervisor takes
          // `--out-cap <outputBytesLimit>` in each replayed exec, so a mismatch
          // here invalidates Dagger's per-replay layer cache.
          outputBytesLimit: config.skillsSandbox.outputBytesLimit,
          fileSizeLimitBytes: config.skillsSandbox.artifactBytesLimit,
          cpuSeconds: config.skillsSandbox.cpuLimit,
          memoryBytes: config.skillsSandbox.memoryLimit,
        });
      } catch (error) {
        throw this.toSkillError(error);
      }

      const data = Buffer.from(artifact.dataBase64, "base64");
      const mimeType = resolveArtifactMime({
        buffer: data,
        claimed: params.mimeType,
      });
      let row: Awaited<ReturnType<typeof SkillSandboxArtifactModel.create>>;
      try {
        row = await SkillSandboxArtifactModel.create({
          sandboxId: params.sandboxId,
          organizationId: sandbox.organizationId,
          path: resolvedPath,
          mimeType,
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

  /**
   * Best-effort append of a placeholder command row when the runtime failed in
   * a way that may have left the command partially executed inside Dagger.
   * Replays re-execute it on the next call, restoring deterministic state.
   * Failures of this append are logged and swallowed — the original error is
   * what the caller cares about.
   */
  private async appendSyntheticRow(args: {
    sandboxId: SandboxId;
    organizationId: string;
    command: string;
    cwd: string | null;
    timeoutSeconds: number;
  }): Promise<void> {
    try {
      await SkillSandboxCommandModel.append({
        sandboxId: args.sandboxId,
        organizationId: args.organizationId,
        command: args.command,
        cwd: args.cwd,
        stdout: "",
        stderr: "",
        exitCode: SYNTHETIC_ENGINE_FAILURE_EXIT_CODE,
        durationMs: 0,
        timeoutSeconds: args.timeoutSeconds,
      });
    } catch (dbError) {
      logger.error(
        { err: dbError, sandboxId: args.sandboxId },
        "[SkillSandbox] failed to persist synthetic command row after engine error",
      );
    }
  }

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
    pythonpath: string | undefined;
  }> {
    const [snapshotRows, log] = await Promise.all([
      SkillSandboxFileSnapshotModel.listBySandbox(sandbox.id),
      SkillSandboxCommandModel.listBySandbox(sandbox.id),
    ]);
    if (snapshotRows.length === 0) {
      throw new SkillSandboxError(
        `sandbox ${sandbox.id} has no file snapshots — recreate the sandbox`,
      );
    }
    return {
      snapshots: snapshotRows.map(
        (snapshot): SnapshotFile => ({
          skillName: snapshot.skillName,
          path: snapshot.path,
          encoding: snapshot.encoding,
          content: snapshot.content,
        }),
      ),
      // uniform replay: every command (including the requirements-install
      // setup steps written at create_skill_sandbox time) lives in the
      // command log. no synthetic "auto-install" prepend here — that lived as
      // its own code path and broke Dagger cache reuse on every config knob.
      replayCommands: log.map(
        (entry): ReplayCommand => ({
          command: entry.command,
          // pin replays to defaultCwd when the original entry has no stored
          // cwd, so the Rust fallback doesn't pick up the live call's cwd
          // (would break replay determinism and the runCommand↔exportArtifact
          // cache).
          cwd: entry.cwd ?? sandbox.defaultCwd,
          timeoutSeconds: entry.timeoutSeconds,
        }),
      ),
      pythonpath: pythonpathForSandbox(sandbox, snapshotRows),
    };
  }

  private toSkillError(error: unknown): SkillSandboxError {
    if (error instanceof SkillSandboxError) return error;
    if (error instanceof DaggerRuntimeError) {
      switch (error.code) {
        case "ARCHESTRA_ARTIFACT_NOT_FOUND":
        case "ARCHESTRA_ARTIFACT_TOO_LARGE":
          return new SkillSandboxError(error.message);
        case "ARCHESTRA_COMMAND_FAILED":
          // A replay or setup command exited non-zero and the SDK refused
          // expect=Any (typically a signal kill, e.g. SIGXFSZ→153). Surface
          // the exit code to the model so it can react instead of looping.
          logger.error({ err: error }, "[SkillSandbox] sandbox command failed");
          return new SkillSandboxError(
            `a setup or replay command in this sandbox failed: ${error.message}`,
          );
        case "ARCHESTRA_INVALID_INPUT":
          // INVALID_INPUT from the runtime layer says "the Dagger runtime is
          // not enabled"; replace with adapter-specific wording so we never
          // leak the underlying implementation to the model/user.
          return new SkillSandboxError(
            "the skill sandbox runtime is not enabled",
          );
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

function shouldRecordOnFailure(error: unknown): boolean {
  if (!(error instanceof DaggerRuntimeError)) return false;
  // ARCHESTRA_ENGINE_UNREACHABLE is also raised by the JS-side backstop timer
  // alone (no native attempt). Persisting a synthetic row there would re-run
  // the user's command on every subsequent replay forever, including the
  // non-idempotent ones (rm, apt, network). Only persist when the native side
  // actually executed and the engine failed mid-stream.
  return error.code === "ARCHESTRA_INTERNAL";
}

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

/**
 * Synthesise one `uv pip install -r requirements.txt` per mounted skill that
 * ships a top-level requirements.txt. Primary skill first so its deps take
 * precedence on version conflicts; rest in deterministic alphabetical order.
 * Returns [] for skills without a requirements.txt — skill authors aren't
 * required to declare one.
 */
/**
 * Order skill names primary-first, then the rest alphabetically — so the
 * primary skill's modules and requirements take precedence over same-named
 * ones in secondary skills.
 */
function orderPrimaryFirst(
  names: Iterable<string>,
  primary: string | undefined,
): string[] {
  const rest = [...new Set(names)].filter((name) => name !== primary).sort();
  return primary ? [primary, ...rest] : rest;
}

function autoInstallCommands(
  sandbox: SkillSandbox,
  snapshotRows: SkillSandboxFileSnapshot[],
): ReplayCommand[] {
  const namesWithReqs = new Set<string>();
  let primary: string | undefined;
  for (const row of snapshotRows) {
    if (row.path === REQUIREMENTS_FILE) {
      namesWithReqs.add(row.skillName);
      if (sandbox.primarySkillId && row.skillId === sandbox.primarySkillId) {
        primary = row.skillName;
      }
    }
  }
  if (namesWithReqs.size === 0) return [];
  return orderPrimaryFirst(namesWithReqs, primary).map(
    (name): ReplayCommand => {
      // shell-quote the path: skill names become path segments and may contain
      // spaces, which would otherwise word-split the `-r` argument.
      const reqPath = shellQuote(`${skillRootPath(name)}/${REQUIREMENTS_FILE}`);
      return {
        command: `uv pip install --python ${VENV_PYTHON} --quiet -r ${reqPath}`,
        cwd: SKILL_SANDBOX_HOME,
        timeoutSeconds: REQUIREMENTS_INSTALL_TIMEOUT_SECONDS,
      };
    },
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the PYTHONPATH for a sandbox: every mounted skill's root, primary
 * first so `import core...` resolves there before any same-named module in a
 * secondary skill. Falls back to the union of snapshot skill names when the
 * primary FK is null (skill was deleted after sandbox creation).
 */
function pythonpathForSandbox(
  sandbox: SkillSandbox,
  snapshotRows: SkillSandboxFileSnapshot[],
): string | undefined {
  const skillNames = new Set<string>();
  let primary: string | undefined;
  for (const row of snapshotRows) {
    skillNames.add(row.skillName);
    if (sandbox.primarySkillId && row.skillId === sandbox.primarySkillId) {
      primary = row.skillName;
    }
  }
  if (skillNames.size === 0) return undefined;
  const ordered = orderPrimaryFirst(skillNames, primary);
  return ordered.map((name) => skillRootPath(name)).join(":");
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
  pythonpathForSandbox,
  autoInstallCommands,
};
