import type { SandboxId } from "@/types";

/**
 * Fixed limits exposed to tool-layer schemas and per-sandbox queueing.
 * Runtime resource limits are env-driven through `config.skillsSandbox`.
 */
export const SKILL_SANDBOX_LIMITS = {
  maxSandboxQueueLength: 10,
  maxCommandBytes: 16 * 1024,
} as const;

export interface RunCommandParams {
  sandboxId: SandboxId;
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
}

export interface ExportArtifactParams {
  sandboxId: SandboxId;
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
}

export interface UploadRef {
  uploadId: string;
  sandboxId: SandboxId;
  path: string;
  mimeType: string;
  sizeBytes: number;
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
