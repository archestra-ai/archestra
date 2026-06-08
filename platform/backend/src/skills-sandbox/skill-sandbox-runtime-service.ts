import type { ReplayEntry } from "@archestra/sandbox-rs";
import config from "@/config";
import logger from "@/logging";
import {
  ConversationAttachmentModel,
  SkillInvalidFilePathError,
  SkillSandboxFileModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
} from "@/models";
import * as metrics from "@/observability/metrics";
import {
  SandboxRuntimeError,
  sandboxRuntimeService,
} from "@/sandbox-runtime/sandbox-runtime-service";
import { assertMountedSkillsReadable } from "@/skills/assert-mounted-skills-readable";
import type { SkillSandbox } from "@/types";
import { asSandboxId, type SandboxId } from "@/types";
import { resolveArtifactMime } from "./mime-sniff";
import {
  SKILL_SANDBOX_ATTACHMENTS_DIR,
  SKILL_SANDBOX_HOME,
  SKILL_SANDBOX_ROOT,
  skillRootPath,
} from "./runtime-image";
import {
  type ArtifactRef,
  type CommandResult,
  type ExportArtifactParams,
  type MountRef,
  type MountSkillParams,
  type RunCommandParams,
  SKILL_SANDBOX_LIMITS,
  SkillSandboxError,
  type UploadFileParams,
  type UploadRef,
} from "./types";

const CONSUMER_ID = "skill-sandbox";
// synthetic exit code recorded when the runtime errored mid-call and the real
// exit status was lost. distinct from any value the wrapped bash subprocess
// can produce (which is bounded to 0..255).
const SYNTHETIC_ENGINE_FAILURE_EXIT_CODE = -1;
const REQUIREMENTS_FILE = "requirements.txt";
// reserved at the skill root: the mount synthesizes this from the pinned
// version body, so a resource file may not occupy it or any subpath of it.
const SKILL_MANIFEST_FILE = "SKILL.md";
// re-exported alias kept for the {@link} references below; the staging dir is
// defined alongside the other container paths in runtime-image.
const ATTACHMENTS_DIR = SKILL_SANDBOX_ATTACHMENTS_DIR;
// covers the cold first install for a typical skill (pillow + a few siblings);
// subsequent calls hit Dagger's layer cache and finish in ms.
const REQUIREMENTS_INSTALL_TIMEOUT_SECONDS = 180;

/**
 * Orchestrates DB-backed skill sandboxes: loads snapshots + replay log,
 * delegates execution to the unified `sandboxRuntimeService`, appends the
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
    return config.skillsSandbox.enabled && sandboxRuntimeService.isEnabled;
  }

  get isReady(): boolean {
    return sandboxRuntimeService.isReady;
  }

  async init(): Promise<void> {
    if (!config.skillsSandbox.enabled) return;
    await sandboxRuntimeService.attach(CONSUMER_ID);
  }

  async shutdown(): Promise<void> {
    await sandboxRuntimeService.detach(CONSUMER_ID);
  }

  async runCommand(params: RunCommandParams): Promise<CommandResult> {
    this.ensureEnabled();
    validateCommand(params.command);
    const timeoutSeconds = this.resolveTimeout(params.timeoutSeconds);

    return this.runExclusive(params.sandboxId, async () => {
      const sandbox = await this.loadSandbox(params.sandboxId);
      await this.assertMountsReadable(params.sandboxId, params.caller);
      // stage chat attachments before building context so they're part of this
      // run's replay (the model sees them under /home/sandbox/attachments/).
      const stagingNotices = await stageConversationAttachments(sandbox);
      const cwd = params.cwd ?? sandbox.defaultCwd;
      const { replayEntries } = await this.buildContext(sandbox);

      let executed: Awaited<
        ReturnType<typeof sandboxRuntimeService.runCommand>
      >;
      const startedAt = Date.now();
      try {
        executed = await sandboxRuntimeService.runCommand({
          command: params.command,
          cwd,
          timeoutSeconds,
          replayEntries,
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
        // wall-clock of the failed engine call (the inner durationMs is lost on
        // throw); the success path below observes the engine-reported duration.
        metrics.sandbox.reportCommand({
          status: "runtime_error",
          durationSeconds: (Date.now() - startedAt) / 1000,
        });
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

      metrics.sandbox.reportCommand({
        status: metrics.sandbox.classifyCommandStatus(executed),
        durationSeconds: executed.durationMs / 1000,
      });

      let row: Awaited<
        ReturnType<typeof SkillSandboxReplayEventModel.appendCommand>
      >;
      try {
        row = await SkillSandboxReplayEventModel.appendCommand({
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
        stagingNotices,
      };
    });
  }

  async exportArtifact(params: ExportArtifactParams): Promise<ArtifactRef> {
    this.ensureEnabled();

    return this.runExclusive(params.sandboxId, async () => {
      const sandbox = await this.loadSandbox(params.sandboxId);
      await this.assertMountsReadable(params.sandboxId, params.caller);
      const stagingNotices = await stageConversationAttachments(sandbox);
      const resolvedPath = resolveArtifactPath({
        path: params.path,
        defaultCwd: sandbox.defaultCwd,
      });
      const { replayEntries } = await this.buildContext(sandbox);

      let artifact: Awaited<
        ReturnType<typeof sandboxRuntimeService.readArtifact>
      >;
      try {
        artifact = await sandboxRuntimeService.readArtifact({
          replayEntries,
          path: resolvedPath,
          defaultCwd: sandbox.defaultCwd,
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
      let row: Awaited<ReturnType<typeof SkillSandboxFileModel.createArtifact>>;
      try {
        row = await SkillSandboxFileModel.createArtifact({
          sandboxId: params.sandboxId,
          path: resolvedPath,
          mimeType,
          originalName: null,
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
        stagingNotices,
      };
    });
  }

  /**
   * Persist an uploaded file as an ordered replay event. No Dagger work happens
   * here — the bytes become part of the recipe and are materialized on the next
   * run/export. Serialized through `runExclusive` so the upload's sequence lands
   * after any in-flight command's append and before the next run reads context;
   * otherwise replay order could diverge from execution order.
   */
  async uploadFile(params: UploadFileParams): Promise<UploadRef> {
    this.ensureEnabled();

    return this.runExclusive(params.sandboxId, async () => {
      const sandbox = await this.loadSandbox(params.sandboxId);
      const resolvedPath = resolveArtifactPath({
        path: params.path,
        defaultCwd: sandbox.defaultCwd,
      });
      // reject paths the Rust replay validator would later reject, so a bad
      // upload fails this call instead of poisoning every future replay.
      validateUploadPath(resolvedPath);

      const limit = config.skillsSandbox.artifactBytesLimit;
      if (params.data.byteLength > limit) {
        throw new SkillSandboxError(
          `uploaded file is too large (${params.data.byteLength} bytes > ${limit} byte limit)`,
        );
      }
      if (params.data.byteLength === 0) {
        throw new SkillSandboxError("uploaded file is empty");
      }

      const mimeType = resolveArtifactMime({
        buffer: params.data,
        claimed: params.mimeType,
      });

      let row: Awaited<
        ReturnType<typeof SkillSandboxReplayEventModel.appendUpload>
      >;
      try {
        row = await SkillSandboxReplayEventModel.appendUpload({
          sandboxId: params.sandboxId,
          path: resolvedPath,
          mimeType,
          originalName: params.originalName ?? null,
          sizeBytes: params.data.byteLength,
          data: params.data,
          sourceAttachmentId: params.dedupeId ?? null,
        });
      } catch (dbError) {
        throw new SkillSandboxError(
          `failed to persist upload: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
        );
      }
      // null means the ON CONFLICT index fired and the insert was a no-op.
      // When dedupeId is set this is intentional idempotency — look up the
      // already-staged row and return its ref. Without dedupeId there is no
      // dedup key, so a null here is a genuine failure.
      if (!row) {
        if (!params.dedupeId) {
          throw new SkillSandboxError("failed to persist upload");
        }
        const existing = await SkillSandboxFileModel.findUploadByDedupeId(
          params.sandboxId,
          params.dedupeId,
        );
        if (!existing) {
          throw new SkillSandboxError(
            "failed to persist upload: dedup conflict but existing row not found",
          );
        }
        return {
          uploadId: existing.id,
          sandboxId: params.sandboxId,
          path: existing.path,
          mimeType: existing.mimeType,
          sizeBytes: existing.sizeBytes,
        };
      }

      return {
        uploadId: row.id,
        sandboxId: params.sandboxId,
        path: row.path,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
      };
    });
  }

  /**
   * Mount an immutable skill version into a sandbox: append a `skill_mount`
   * replay event pinning the version and — if the version ships a
   * `requirements.txt` — a `uv pip install` command right after it, both in one
   * transaction so the deps can never be lost. No Dagger work happens here; the
   * mount becomes part of the recipe and materializes on the next run/export.
   *
   * Idempotent and race-safe: `appendSkillMount` inserts under a
   * `(sandbox_id, skill_id)` unique constraint, so a concurrent or repeated
   * activation of the same skill is a no-op that returns null. The version's
   * files are read here to detect requirements and to reject any path that the
   * Rust replay validator would later refuse.
   */
  async mountSkill(params: MountSkillParams): Promise<MountRef | null> {
    this.ensureEnabled();

    return this.runExclusive(params.sandboxId, async () => {
      const sandbox = await this.loadSandbox(params.sandboxId);

      const files = await SkillVersionModel.findFiles(
        params.skill.skillVersionId,
      );
      for (const file of files) {
        validateSkillMountFilePath(params.skill.skillName, file.path);
      }

      // install the skill's requirements into the shared uv project as a replay
      // command right after the mount, mirroring how user commands replay. We
      // use `uv add` (not bare `uv pip install`) so the deps are recorded in
      // pyproject/uv.lock — otherwise a later model `uv add <pkg>` could prune
      // them as extraneous on sync. `--project` lets it run from any cwd.
      const installCommand = files.some((f) => f.path === REQUIREMENTS_FILE)
        ? {
            command: `uv add --project ${SKILL_SANDBOX_HOME} --quiet -r ${shellQuote(
              `${skillRootPath(params.skill.skillName)}/${REQUIREMENTS_FILE}`,
            )}`,
            cwd: SKILL_SANDBOX_HOME,
            timeoutSeconds: REQUIREMENTS_INSTALL_TIMEOUT_SECONDS,
          }
        : undefined;

      let mount: Awaited<
        ReturnType<typeof SkillSandboxReplayEventModel.appendSkillMount>
      >;
      try {
        mount = await SkillSandboxReplayEventModel.appendSkillMount({
          sandboxId: params.sandboxId,
          organizationId: sandbox.organizationId,
          mount: {
            skillId: params.skill.skillId,
            skillName: params.skill.skillName,
            skillVersionId: params.skill.skillVersionId,
          },
          installCommand,
        });
      } catch (dbError) {
        throw new SkillSandboxError(
          `failed to mount skill: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
        );
      }
      // already mounted: ON CONFLICT made the insert a no-op.
      if (!mount) return null;

      return {
        mountId: mount.id,
        sandboxId: params.sandboxId,
        skillName: params.skill.skillName,
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
      await SkillSandboxReplayEventModel.appendCommand({
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

  /**
   * Fail-closed before materializing: every mounted skill must still be readable
   * by the caller. A revoked or deleted skill stops the run before any bytes
   * execute (see {@link assertMountedSkillsReadable}).
   */
  private async assertMountsReadable(
    sandboxId: SandboxId,
    caller: { userId: string; organizationId: string },
  ): Promise<void> {
    const result = await assertMountedSkillsReadable({
      sandboxId,
      userId: caller.userId,
      organizationId: caller.organizationId,
    });
    if (!result.ok) {
      logger.warn(
        {
          sandboxId,
          userId: caller.userId,
          organizationId: caller.organizationId,
          reason: result.code,
        },
        "[SkillSandbox] revocation gate blocked sandbox access",
      );
      throw new SkillSandboxError(result.reason);
    }
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
    replayEntries: ReplayEntry[];
  }> {
    const log = await SkillSandboxReplayEventModel.listBySandbox(sandbox.id);
    return {
      // uniform, ordered replay: every command (including per-skill
      // requirements-install steps), every uploaded file, and every skill mount
      // lives in one sequenced log. interleaving is preserved so each step
      // materializes at exactly its sequence point. an empty log is valid — a
      // freshly-created default sandbox is just a plain shell.
      replayEntries: log.map((entry): ReplayEntry => {
        switch (entry.kind) {
          case "command":
            return {
              kind: "command",
              command: {
                command: entry.command.command,
                // pin replays to defaultCwd when the original entry has no
                // stored cwd, so the Rust fallback doesn't pick up the live
                // call's cwd (would break replay determinism and the
                // runCommand↔exportArtifact cache).
                cwd: entry.command.cwd ?? sandbox.defaultCwd,
                timeoutSeconds: entry.command.timeoutSeconds,
              },
            };
          case "upload":
            return {
              kind: "file",
              file: {
                path: entry.upload.path,
                encoding: "base64",
                content: entry.upload.data.toString("base64"),
              },
            };
          case "skill_mount":
            return {
              kind: "skill_mount",
              skillMount: {
                skillName: entry.mount.skillName,
                // synthesize the skill dir from the pinned version: SKILL.md
                // from the version body, plus one entry per version file. The
                // per-file `skillName` is the mount's name (version files are
                // skill-agnostic), so paths land under /skills/<skillName>.
                files: [
                  {
                    skillName: entry.mount.skillName,
                    path: SKILL_MANIFEST_FILE,
                    encoding: "utf8" as const,
                    content: entry.content,
                  },
                  ...entry.files.map((file) => ({
                    skillName: entry.mount.skillName,
                    path: file.path,
                    encoding: file.encoding,
                    content: file.content,
                  })),
                ],
              },
            };
          default:
            throw new SkillSandboxError(
              `replay event for sandbox ${sandbox.id} has an unknown kind ${JSON.stringify(entry)}`,
            );
        }
      }),
    };
  }

  private toSkillError(error: unknown): SkillSandboxError {
    if (error instanceof SkillSandboxError) return error;
    if (error instanceof SandboxRuntimeError) {
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
          // INVALID_INPUT from the runtime layer says "the sandbox runtime is
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
  if (!(error instanceof SandboxRuntimeError)) return false;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Reject a sandbox path with a stable reason code logged for audit. The raw
 * path stays in the model-facing message only — never in the structured log —
 * to avoid leaking user-supplied content into operational logs.
 */
function rejectPath(reason: string, message: string): never {
  logger.warn({ reason }, "[SkillSandbox] rejected sandbox path");
  throw new SkillSandboxError(message);
}

function resolveArtifactPath(params: {
  path: string;
  defaultCwd: string;
}): string {
  if (params.path.includes("\0")) {
    rejectPath(
      "artifact_path_nul",
      `invalid artifact path: ${JSON.stringify(params.path)}`,
    );
  }
  if (params.path.split("/").some((segment) => segment === "..")) {
    rejectPath(
      "artifact_path_traversal",
      `invalid artifact path: ${JSON.stringify(params.path)}`,
    );
  }
  if (params.path.startsWith("/")) {
    const allowedRoots = [SKILL_SANDBOX_ROOT, SKILL_SANDBOX_HOME];
    const isAllowed = allowedRoots.some(
      (root) => params.path === root || params.path.startsWith(`${root}/`),
    );
    if (!isAllowed) {
      rejectPath(
        "artifact_path_outside_roots",
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

/**
 * TS twin of the Rust `validate_upload_path`, run on the already-resolved
 * absolute path. `resolveArtifactPath` covers null bytes, `..` traversal, and
 * the under-roots bound; this adds the remaining replay-validator checks (shell
 * metacharacters, directory targets) so the upload is rejected at the tool call
 * rather than after it has been persisted as an unreplayable event.
 */
function validateUploadPath(path: string): void {
  if (/["$`\\\n\r]/.test(path)) {
    rejectPath(
      "upload_path_shell_metachar",
      `invalid upload path: ${JSON.stringify(path)}`,
    );
  }
  if (path.endsWith("/")) {
    rejectPath(
      "upload_path_directory",
      `upload path must be a file, not a directory: ${JSON.stringify(path)}`,
    );
  }
  // the sandbox roots themselves are directories: uploading to one would either
  // replay-fail forever (/home/sandbox already exists) or shadow /skills with a
  // regular file and break every later skill mount. reject before it is
  // persisted as an unreplayable event.
  if (path === SKILL_SANDBOX_ROOT || path === SKILL_SANDBOX_HOME) {
    rejectPath(
      "upload_path_root_directory",
      `upload path must be a file, not a directory: ${JSON.stringify(path)}`,
    );
  }
}

/**
 * Reject a skill resource path before it is persisted as a mount. Beyond the
 * absolute/`..` checks the Rust replay validator runs, this normalizes away `.`
 * and empty segments and rejects the whole reserved `SKILL.md` subtree: paths
 * like `./SKILL.md` (would clobber the synthesized manifest) and
 * `SKILL.md/injected.txt` (treats the manifest as a directory) pass
 * create/update input validation but would break every later `run_command`.
 */
function validateSkillMountFilePath(skillName: string, path: string): void {
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  if (
    path.startsWith("/") ||
    segments.length === 0 ||
    segments.some((s) => s === "..") ||
    segments[0] === SKILL_MANIFEST_FILE
  ) {
    throw new SkillInvalidFilePathError(skillName, path);
  }
}

/**
 * Stage the conversation's chat attachments into the default sandbox as upload
 * replay events under {@link ATTACHMENTS_DIR}, so the model can use files the
 * user attached without knowing any attachment id. Idempotent and multi-turn
 * safe: only attachments not already staged (tracked via `source_attachment_id`)
 * are appended, and the DB-level partial unique index makes a concurrent repeat
 * a no-op.
 *
 * Scope is the sandbox's own conversation — the sandbox was already access-
 * checked (org + user + conversation) at target resolution, so attachments can
 * never cross into another conversation. Returns model-visible notices for
 * attachments skipped (e.g. over the size limit) so a missing file is never
 * silently assumed present. Pure DB I/O — must run inside the per-sandbox queue.
 */
async function stageConversationAttachments(
  sandbox: SkillSandbox,
): Promise<string[]> {
  // only the conversation's default sandbox auto-absorbs attachments; fresh /
  // explicit sandboxes are opt-in surfaces the caller drives with upload_file.
  if (!sandbox.isDefault || !sandbox.conversationId) return [];

  const attachments =
    await ConversationAttachmentModel.findByConversationIdWithoutData(
      sandbox.conversationId,
    );
  if (attachments.length === 0) return [];

  const stagedIds = await SkillSandboxFileModel.listStagedAttachmentIds(
    sandbox.id,
  );
  const limit = config.skillsSandbox.artifactBytesLimit;
  const { toStage, notices, oversized } = planAttachmentStaging({
    attachments,
    stagedIds,
    limit,
  });
  for (const skip of oversized) {
    // debug, not warn: an oversize attachment is expected and recoverable (the
    // model gets a notice + download URL), and staging re-runs every op — a warn
    // here would repeat for the whole conversation.
    logger.debug(
      {
        sandboxId: sandbox.id,
        attachmentId: skip.attachmentId,
        sizeBytes: skip.sizeBytes,
        limit,
      },
      "[SkillSandbox] skipped oversize attachment during auto-staging",
    );
  }
  if (toStage.length === 0) return notices;

  const withData = await ConversationAttachmentModel.findByIdsWithData(
    toStage.map((a) => a.id),
  );
  const dataById = new Map(withData.map((a) => [a.id, a]));

  for (const { id, path } of toStage) {
    const full = dataById.get(id);
    // soft-deleted between the metadata read and here — skip; next op re-syncs.
    if (!full) continue;
    // sanitized names are always valid; this guards our own path logic and
    // fails loudly (not silently) if that ever regresses.
    validateUploadPath(path);
    await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      path,
      mimeType: full.mimeType,
      originalName: full.originalName,
      sizeBytes: full.fileData.byteLength,
      data: full.fileData,
      sourceAttachmentId: full.id,
    });
  }
  return notices;
}

/**
 * Decide which conversation attachments to stage and where. Pure policy (no
 * I/O): assigns deterministic paths over the full ordered attachment set, skips
 * the already-staged ones, and emits a notice for any that exceed `limit`.
 */
function planAttachmentStaging(params: {
  attachments: { id: string; originalName: string | null; fileSize: number }[];
  stagedIds: Set<string>;
  limit: number;
}): {
  toStage: { id: string; path: string }[];
  notices: string[];
  oversized: { attachmentId: string; sizeBytes: number }[];
} {
  const { attachments, stagedIds, limit } = params;
  const pathByAttachment = assignAttachmentPaths(attachments);
  const notices: string[] = [];
  const oversized: { attachmentId: string; sizeBytes: number }[] = [];
  const toStage: { id: string; path: string }[] = [];
  for (const attachment of attachments) {
    if (stagedIds.has(attachment.id)) continue;
    if (attachment.fileSize > limit) {
      notices.push(
        `attachment ${JSON.stringify(attachment.originalName ?? attachment.id)} (${attachment.fileSize} bytes) was not auto-staged into the sandbox: it exceeds the ${limit}-byte file limit. Reference it via its download URL instead.`,
      );
      oversized.push({
        attachmentId: attachment.id,
        sizeBytes: attachment.fileSize,
      });
      continue;
    }
    const path = pathByAttachment.get(attachment.id);
    if (path) toStage.push({ id: attachment.id, path });
  }
  return { toStage, notices, oversized };
}

/**
 * Map each conversation attachment to a deterministic, shell-safe absolute path
 * under {@link ATTACHMENTS_DIR}. Duplicate sanitized names get a short
 * attachment-id suffix; the input order (created_at, id) is stable, so a given
 * attachment always resolves to the same path across turns.
 */
function assignAttachmentPaths(
  attachments: { id: string; originalName: string | null }[],
): Map<string, string> {
  const used = new Set<string>();
  const paths = new Map<string, string>();
  for (const attachment of attachments) {
    const safe = sanitizeAttachmentName(attachment.originalName, attachment.id);
    let name = safe;
    if (used.has(name)) {
      const short = attachment.id.slice(0, 8);
      const dot = safe.lastIndexOf(".");
      name =
        dot > 0
          ? `${safe.slice(0, dot)}-${short}${safe.slice(dot)}`
          : `${safe}-${short}`;
    }
    used.add(name);
    paths.set(attachment.id, `${ATTACHMENTS_DIR}/${name}`);
  }
  return paths;
}

/**
 * Reduce a caller-supplied filename to a single shell-safe path segment: keep
 * only `[A-Za-z0-9._-]`, drop any directory prefix and leading dots (so `..`
 * can't escape), and fall back to the attachment id when nothing usable remains.
 */
function sanitizeAttachmentName(
  originalName: string | null,
  attachmentId: string,
): string {
  const base = (originalName ?? "").split("/").pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (cleaned === "") {
    return `attachment-${attachmentId.slice(0, 8)}`;
  }
  return cleaned;
}

/** @public — exported for tests */
export const __internals = {
  resolveArtifactPath,
  validateUploadPath,
  validateSkillMountFilePath,
  stageConversationAttachments,
  planAttachmentStaging,
  assignAttachmentPaths,
  sanitizeAttachmentName,
  asSandboxId,
};
