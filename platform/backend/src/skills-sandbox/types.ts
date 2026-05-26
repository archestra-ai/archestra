import type { SandboxId } from "@/types";

/**
 * Limits enforced by the skill sandbox runtime. These mirror the env-driven
 * defaults in `config.skillsSandbox` but are exposed as a frozen object so
 * tool-layer schemas can reference them.
 */
export const SKILL_SANDBOX_LIMITS = {
  maxCpuSeconds: 30,
  maxMemoryBytes: 1024 * 1024 * 1024,
  maxProcesses: 256,
  maxQueueLength: 50,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxCommandBytes: 16 * 1024,
} as const;

export type SkillSandboxStatus =
  | "disabled"
  | "initializing"
  | "ready"
  | "error"
  | "stopped";

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

/**
 * Materialized skill roots returned to callers so they can document where
 * relative paths in commands resolve.
 */
export interface SkillRoot {
  skillId: string;
  skillName: string;
  rootPath: string;
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
