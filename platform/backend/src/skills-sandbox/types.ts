import type { SandboxId } from "@/types";

/**
 * Fixed limits exposed to tool-layer schemas and per-sandbox queueing.
 * Runtime resource limits are env-driven through `config.skillsSandbox`.
 */
export const SKILL_SANDBOX_LIMITS = {
  maxSandboxQueueLength: 10,
  maxCommandBytes: 16 * 1024,
} as const;

/**
 * Caller identity threaded into the materializing tools so the revocation gate
 * can re-check the caller's `skill:read` on every mounted skill before a
 * container is built.
 */
export interface SandboxCaller {
  userId: string;
  organizationId: string;
}

export interface RunCommandParams {
  sandboxId: SandboxId;
  caller: SandboxCaller;
  command: string;
  /** Absolute path inside the container; defaults to the sandbox's `defaultCwd`. */
  cwd?: string;
  /** Caller-requested wall-clock cap in seconds; clamped to the configured maximum. */
  timeoutSeconds?: number;
}

export interface CommandResult {
  commandId: string;
  sandboxId: SandboxId;
  command: string;
  cwd: string | null;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** The command was killed by the wall-clock timeout. */
  timedOut: boolean;
  /** stdout or stderr was truncated to the configured byte cap. */
  truncated: boolean;
  /**
   * Human-readable notices about chat attachments that could not be auto-staged
   * (e.g. too large). Empty when everything staged cleanly. Surfaced to the
   * model so a skipped attachment is never silently assumed present.
   */
  stagingNotices: string[];
}

export interface ExportArtifactParams {
  sandboxId: SandboxId;
  caller: SandboxCaller;
  /** Path inside the container, either absolute or relative to `defaultCwd`. */
  path: string;
  mimeType?: string;
}

export interface ArtifactRef {
  artifactId: string;
  sandboxId: SandboxId;
  path: string;
  mimeType: string;
  sizeBytes: number;
  /** See {@link CommandResult.stagingNotices}. */
  stagingNotices: string[];
}

export interface UploadFileParams {
  sandboxId: SandboxId;
  /** Path inside the container, either absolute or relative to `defaultCwd`. */
  path: string;
  /** Raw file bytes to materialize into the sandbox replay recipe. */
  data: Buffer;
  /** Optional MIME type; sniffed from the bytes when omitted. */
  mimeType?: string;
  /** Optional source filename, recorded for provenance. */
  originalName?: string;
  /**
   * When set, the upload is idempotent per (sandbox, dedupeId) via the
   * `skill_sandbox_files_sandbox_attachment_uidx` partial unique index —
   * a repeat call with the same (sandboxId, dedupeId) is a no-op that returns
   * the already-staged file's ref rather than inserting a duplicate row or
   * replay event. Must be a UUID string. When omitted, the upload always
   * appends a new row (existing tool-upload behavior).
   */
  dedupeId?: string;
}

export interface UploadRef {
  uploadId: string;
  sandboxId: SandboxId;
  path: string;
  mimeType: string;
  sizeBytes: number;
}

/** Identity of the immutable skill version to mount into a sandbox. */
export interface SkillMountInput {
  skillId: string;
  skillName: string;
  /** The `skill_versions` row whose bytes the mount pins. */
  skillVersionId: string;
}

export interface MountSkillParams {
  sandboxId: SandboxId;
  skill: SkillMountInput;
}

export interface MountRef {
  mountId: string;
  sandboxId: SandboxId;
  skillName: string;
}

/**
 * Raised when the runtime cannot execute the requested operation — engine
 * unreachable, sandbox missing, limits violated. A command that runs and exits
 * non-zero is a normal {@link CommandResult}, not an error.
 */
export class SkillSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillSandboxError";
  }
}
