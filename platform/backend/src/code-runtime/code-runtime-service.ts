import config from "@/config";
import {
  DaggerRuntimeError,
  daggerRuntimeService,
} from "@/dagger-runtime/dagger-runtime-service";
import logger from "@/logging";
import * as metrics from "@/observability/metrics";
import {
  CODE_RUNTIME_LIMITS,
  CodeRuntimeError,
  type RunCodeParams,
  type RunCodeResult,
} from "./types";

const CONSUMER_ID = "code-runtime";
const SKILL_NAME = "_code";
const SCRIPT_FILE = "main.py";
const SKILL_DIR = `/skills/${SKILL_NAME}`;
const VENV_PYTHON = "/home/sandbox/.venv/bin/python";

/**
 * Thin adapter over the unified `daggerRuntimeService`. Takes a Python script
 * (and optional pip requirements), snapshots it into the shared warm sandbox,
 * and runs it. The native side owns the Dagger session + warm venv.
 */
class CodeRuntimeService {
  get isEnabled(): boolean {
    return config.codeRuntime.enabled && daggerRuntimeService.isEnabled;
  }

  get isReady(): boolean {
    return daggerRuntimeService.isReady;
  }

  async init(): Promise<void> {
    if (!config.codeRuntime.enabled) return;
    await daggerRuntimeService.attach(CONSUMER_ID);
  }

  async shutdown(): Promise<void> {
    await daggerRuntimeService.detach(CONSUMER_ID);
  }

  async run(params: RunCodeParams): Promise<RunCodeResult> {
    if (!this.isEnabled) {
      throw new CodeRuntimeError("the code runtime is not enabled");
    }
    const validated = validateRunParams(params);
    const timeoutSeconds = this.resolveTimeout(params.timeoutSeconds);

    const startedAt = Date.now();
    try {
      const executed = await daggerRuntimeService.runCommand({
        command: buildPythonCommand(validated.requirements),
        cwd: SKILL_DIR,
        timeoutSeconds,
        snapshots: [
          {
            skillName: SKILL_NAME,
            path: SCRIPT_FILE,
            encoding: "utf8",
            content: validated.code,
          },
        ],
        outputBytesLimit: config.codeRuntime.maxOutputBytes,
        cpuSeconds: CODE_RUNTIME_LIMITS.maxCpuSeconds,
        memoryBytes: CODE_RUNTIME_LIMITS.maxMemoryBytes,
      });
      const durationMs = executed.durationMs;
      metrics.codeRuntime.reportRun(
        executed.timedOut
          ? "timeout"
          : executed.exitCode === 0
            ? "ok"
            : "script_error",
        durationMs / 1000,
      );
      return {
        stdout: executed.stdout,
        stderr: executed.stderr,
        exitCode: executed.exitCode,
        durationMs,
        timedOut: executed.timedOut,
        truncated: executed.truncated,
      };
    } catch (error) {
      metrics.codeRuntime.reportRun(
        "runtime_error",
        (Date.now() - startedAt) / 1000,
      );
      throw toCodeRuntimeError(error);
    }
  }

  private resolveTimeout(requested: number | undefined): number {
    const max = config.codeRuntime.timeoutSeconds;
    if (requested === undefined) return max;
    if (!Number.isFinite(requested) || !Number.isInteger(requested)) {
      throw new CodeRuntimeError("timeoutSeconds must be a finite integer");
    }
    if (requested <= 0) {
      throw new CodeRuntimeError("timeoutSeconds must be positive");
    }
    return Math.min(requested, max);
  }
}

export const codeRuntimeService = new CodeRuntimeService();

// === internal helpers ===

/**
 * Hide the underlying runtime (Dagger) from user-visible errors. Mirrors the
 * skill-sandbox adapter's translation table so callers see consistent wording
 * across `run_python` and `run_skill_command`.
 */
function toCodeRuntimeError(error: unknown): CodeRuntimeError {
  if (error instanceof CodeRuntimeError) return error;
  if (error instanceof DaggerRuntimeError) {
    switch (error.code) {
      case "ARCHESTRA_INVALID_INPUT":
        // INVALID_INPUT messages from the runtime layer mention "Dagger"; the
        // user-facing shape should match skill-sandbox's "not enabled" path.
        return new CodeRuntimeError("the code runtime is not enabled");
      case "ARCHESTRA_COMMAND_FAILED":
        logger.error({ err: error }, "[CodeRuntime] script command failed");
        return new CodeRuntimeError(
          `script execution failed: ${error.message}`,
        );
      case "ARCHESTRA_ENGINE_UNREACHABLE":
      case "ARCHESTRA_INTERNAL":
        logger.error({ err: error }, "[CodeRuntime] runtime error");
        return new CodeRuntimeError(
          "the code runtime is not available (engine unreachable)",
        );
      case "ARCHESTRA_ARTIFACT_NOT_FOUND":
      case "ARCHESTRA_ARTIFACT_TOO_LARGE":
        // not reachable from run() (no artifact read), but cover the union.
        return new CodeRuntimeError(error.message);
    }
  }
  logger.error({ err: error }, "[CodeRuntime] unexpected error");
  return new CodeRuntimeError(
    "the code runtime is not available (engine unreachable)",
  );
}

interface ValidatedRunParams {
  code: string;
  requirements: string[];
}

function validateRunParams(params: RunCodeParams): ValidatedRunParams {
  const codeBytes = Buffer.byteLength(params.code, "utf8");
  if (codeBytes > CODE_RUNTIME_LIMITS.maxCodeBytes) {
    throw new CodeRuntimeError(
      `code is too large (${codeBytes} bytes > ${CODE_RUNTIME_LIMITS.maxCodeBytes} bytes)`,
    );
  }
  return {
    code: params.code,
    requirements: normalizeRequirements(params.requirements),
  };
}

function normalizeRequirements(requirements: string[] | undefined): string[] {
  if (!requirements) return [];
  if (requirements.length > CODE_RUNTIME_LIMITS.maxRequirements) {
    throw new CodeRuntimeError(
      `too many requirements (${requirements.length} > ${CODE_RUNTIME_LIMITS.maxRequirements})`,
    );
  }
  return requirements.map((requirement, index) => {
    const normalized = requirement.trim();
    if (!normalized) {
      throw new CodeRuntimeError(`requirement ${index + 1} is empty`);
    }
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (bytes > CODE_RUNTIME_LIMITS.maxRequirementBytes) {
      throw new CodeRuntimeError(
        `requirement ${index + 1} is too large (${bytes} bytes > ${CODE_RUNTIME_LIMITS.maxRequirementBytes} bytes)`,
      );
    }
    if (/[\r\n\0]/.test(normalized)) {
      throw new CodeRuntimeError(
        `requirement ${index + 1} must be a single line`,
      );
    }
    return normalized;
  });
}

function buildPythonCommand(requirements: string[]): string {
  const installStep =
    requirements.length > 0
      ? `uv pip install --python ${VENV_PYTHON} ${requirements.map(shellQuote).join(" ")} >&2 && `
      : "";
  return `${installStep}${VENV_PYTHON} ${SKILL_DIR}/${SCRIPT_FILE}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
