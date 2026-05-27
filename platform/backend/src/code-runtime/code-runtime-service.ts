import {
  type Client,
  type ConnectOpts,
  type Container,
  connect,
  ReturnType as DaggerReturnType,
} from "@dagger.io/dagger";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import * as metrics from "@/observability/metrics";
import {
  CODE_RUNTIME_LIMITS,
  CodeRuntimeError,
  type RunCodeParams,
  type RunCodeResult,
} from "./types";

type RuntimeStatus =
  | "disabled"
  | "initializing"
  | "ready"
  | "error"
  | "stopped";
type CapturedRun = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
};
type ValidatedRunParams = { code: string; requirements: string[] };
type PreparedContainer =
  | { kind: "ready"; container: Container }
  | { kind: "failed"; result: CapturedRun };

class CodeRuntimeBackstopError extends CodeRuntimeError {
  constructor(readonly pipeline: Promise<unknown>) {
    super("the code run exceeded its time budget");
  }
}

/**
 * runs agent-provided Python scripts in throwaway Dagger containers.
 *
 * each call gets a fresh container filesystem; only Dagger-managed base image
 * and uv package caches persist across calls. concurrency across conversations
 * is capped by a semaphore.
 */
class CodeRuntimeService {
  private status: RuntimeStatus = "disabled";
  private baseContainer: Container | null = null;
  private client: Client | null = null;
  private initPromise: Promise<void> | null = null;
  private sessionPromise: Promise<void> | null = null;
  private stopSession: (() => void) | null = null;
  private lastInitAttemptAt = 0;
  private activeRuns = 0;
  private readonly waiters: Array<() => void> = [];

  /** whether the runtime is configured on (independent of engine health). */
  get isEnabled(): boolean {
    return config.codeRuntime.enabled;
  }

  /** whether the engine is reachable and the base image is pre-warmed. */
  get isReady(): boolean {
    return this.status === "ready";
  }

  /**
   * connects to the Dagger Engine and pre-pulls the base image so the first
   * real run is fast. Idempotent and safe to call from any process — the first
   * call does the work, later calls await it. Never throws.
   */
  init(): Promise<void> {
    if (!config.codeRuntime.enabled) {
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
   * executes a Python script and returns its output. Throws
   * {@link CodeRuntimeError} when the run cannot be performed; a non-zero
   * script exit is a normal result.
   */
  async run(params: RunCodeParams): Promise<RunCodeResult> {
    if (!config.codeRuntime.enabled) {
      throw new CodeRuntimeError("the code runtime is not enabled");
    }
    const runParams = validateRunParams(params);
    const timeoutSeconds = this.resolveTimeout(params.timeoutSeconds);
    // lazily initialize so scheduled-agent runs in worker processes work too.
    await this.init();
    if (this.status === "stopped") {
      throw new CodeRuntimeError("the code runtime is stopped");
    }
    if (this.status !== "ready") {
      throw new CodeRuntimeError(
        "the code runtime is not available (engine unreachable)",
      );
    }

    const startedAt = Date.now();
    let acquired = false;
    let releaseWhenSettled: Promise<unknown> | null = null;
    try {
      await this.acquire();
      acquired = true;
      const result = await this.execute({
        params: runParams,
        startedAt,
        timeoutSeconds,
      });
      metrics.codeRuntime.reportRun(
        result.timedOut
          ? "timeout"
          : result.exitCode === 0
            ? "ok"
            : "script_error",
        result.durationMs / 1000,
      );
      return result;
    } catch (error) {
      if (error instanceof CodeRuntimeBackstopError) {
        releaseWhenSettled = error.pipeline;
      }
      const runtimeError = await this.normalizeRunError(error);
      metrics.codeRuntime.reportRun(
        "runtime_error",
        (Date.now() - startedAt) / 1000,
      );
      throw runtimeError;
    } finally {
      if (acquired) {
        if (releaseWhenSettled) {
          // the backstop already tore the session down; wait briefly for the
          // doomed pipeline to settle, then free the slot regardless so a hung
          // engine cannot leak concurrency permanently.
          const settled = releaseWhenSettled.catch((error) => {
            logger.error(
              { err: error },
              "[CodeRuntime] Dagger pipeline failed after backstop timeout",
            );
          });
          void raceWithTimeout(settled, BACKSTOP_RELEASE_GRACE_MS).finally(
            () => {
              this.release();
            },
          );
        } else {
          this.release();
        }
      }
    }
  }

  /** stops accepting new runs and closes the long-lived Dagger session. */
  async shutdown(): Promise<void> {
    if (this.status !== "disabled") {
      this.status = "stopped";
    }
    await this.closeDaggerSession();
  }

  // === private ===

  private async doInit(): Promise<void> {
    if (!config.codeRuntime.enabled) {
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
        const warmedContainer = await warmBaseContainer(
          buildBaseContainer(client),
        ).sync();
        if (this.client === client) {
          this.baseContainer = warmedContainer;
        }
        resolveReady();
        await sessionClosed;
      } catch (error) {
        rejectReady(error);
        throw error;
      } finally {
        if (this.client === client) {
          this.baseContainer = null;
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
        { image: config.codeRuntime.image },
        "[CodeRuntime] ready — base image and default packages pre-warmed",
      );
    } catch (error) {
      this.status = "error";
      logger.error(
        { err: error },
        "[CodeRuntime] failed to initialize — code execution unavailable",
      );
    }
  }

  private async execute({
    params,
    startedAt,
    timeoutSeconds,
  }: {
    params: ValidatedRunParams;
    startedAt: number;
    timeoutSeconds: number;
  }): Promise<RunCodeResult> {
    const client = this.client;
    const baseContainer = this.baseContainer;
    if (!client || !baseContainer) {
      this.status = "error";
      throw new CodeRuntimeError(
        "the code runtime is not available (engine unreachable)",
      );
    }

    const pipeline = this.executeWithClient({
      baseContainer,
      params,
      timeoutSeconds,
    });

    // the in-container `timeout` should always fire first; this backstop only
    // catches a hung engine/session so the agent is never blocked indefinitely.
    const backstopMs = (timeoutSeconds + BACKSTOP_BUFFER_SECONDS) * 1000;
    if ((await raceWithTimeout(pipeline, backstopMs)) === "timeout") {
      this.status = "error";
      void this.closeDaggerSession();
      throw new CodeRuntimeBackstopError(pipeline);
    }

    const run = await pipeline;
    return {
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: run.timedOut,
      truncated: run.truncated,
    };
  }

  private async executeWithClient({
    baseContainer,
    params,
    timeoutSeconds,
  }: {
    baseContainer: Container;
    params: ValidatedRunParams;
    timeoutSeconds: number;
  }): Promise<CapturedRun> {
    const prepared = await this.installRequirements(
      baseContainer,
      params.requirements,
    );
    if (prepared.kind === "failed") {
      return prepared.result;
    }

    const runnerScript = await loadRunnerScript();
    const container = prepared.container
      .withNewFile(`${WORKDIR}/${RUNNER_FILE}`, runnerScript)
      .withNewFile(`${WORKDIR}/${SCRIPT_FILE}`, params.code)
      .withExec(buildRunnerArgs(timeoutSeconds), {
        expect: DaggerReturnType.Any,
      });
    return parseCapturedRun(await container.file(RESULT_FILE).contents());
  }

  /**
   * installs requested packages into the pre-built venv as a standalone exec.
   * keeping it off the script-bearing container means Dagger's layer cache
   * reuses it across runs, and the install is never charged against the
   * script's CPU budget. a failed install surfaces as a normal non-zero run.
   */
  private async installRequirements(
    baseContainer: Container,
    requirements: string[],
  ): Promise<PreparedContainer> {
    if (requirements.length === 0) {
      return { kind: "ready", container: baseContainer };
    }
    const installed = baseContainer.withExec(
      ["uv", "pip", "install", "--python", VENV_PYTHON, ...requirements],
      { expect: DaggerReturnType.Any },
    );
    const exitCode = await installed.exitCode();
    if (exitCode === 0) {
      return { kind: "ready", container: installed };
    }
    return {
      kind: "failed",
      result: capturedInstallFailure(exitCode, await installed.stderr()),
    };
  }

  private async normalizeRunError(error: unknown): Promise<CodeRuntimeError> {
    if (error instanceof CodeRuntimeError) return error;

    this.status = "error";
    await this.closeDaggerSession();
    logger.error({ err: error }, "[CodeRuntime] Dagger execution failed");
    return new CodeRuntimeError(
      "the code runtime is not available (engine unreachable)",
    );
  }

  private async closeDaggerSession(): Promise<void> {
    this.baseContainer = null;
    this.client = null;
    this.stopSession?.();
    await this.sessionPromise?.catch((error) => {
      logger.error({ err: error }, "[CodeRuntime] Dagger session failed");
    });
  }

  /**
   * points the Dagger SDK at a pre-deployed engine and a baked-in CLI so it
   * never tries to provision its own or download the CLI at runtime.
   */
  private applyDaggerEnv(): void {
    const { daggerRunnerHost, daggerCliBin } = config.codeRuntime;
    process.env._EXPERIMENTAL_DAGGER_RUNNER_HOST = daggerRunnerHost;
    if (daggerCliBin) {
      process.env._EXPERIMENTAL_DAGGER_CLI_BIN = daggerCliBin;
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

  private async acquire(): Promise<void> {
    if (this.activeRuns < config.codeRuntime.maxConcurrent) {
      this.activeRuns++;
      return;
    }
    // cap the queue so a wedged engine cannot pile up unbounded waiters.
    if (this.waiters.length >= CODE_RUNTIME_LIMITS.maxQueueLength) {
      throw new CodeRuntimeError(
        "the code runtime is at capacity — too many runs are already queued",
      );
    }
    // wait for a slot; release() hands one over without decrementing.
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

export const codeRuntimeService = new CodeRuntimeService();

// === internal helpers ===

/** scripts run from /tmp — world-writable, so the non-root image user can write there. */
const WORKDIR = "/tmp";
const SCRIPT_FILE = "main.py";
const RUNNER_FILE = "runner.py";
const RESULT_FILE = `${WORKDIR}/result.json`;
let runnerScriptPromise: Promise<string> | null = null;

async function loadRunnerScript(): Promise<string> {
  runnerScriptPromise ??= import("./runner.py").then(
    (module) => module.default,
  );
  return runnerScriptPromise;
}

const VENV_DIR = `${WORKDIR}/.venv`;
const VENV_PYTHON = `${VENV_DIR}/bin/python`;
const NON_ROOT_USER = "1000:1000";
const DAGGER_CONNECT_OPTS = {
  LoadWorkspaceModules: false,
  Workdir: "/",
} satisfies ConnectOpts;
/** extra time beyond the script's own timeout before the hung-run backstop fires. */
const BACKSTOP_BUFFER_SECONDS = 60;
/** how long to wait for a backstopped pipeline to settle before freeing its slot. */
const BACKSTOP_RELEASE_GRACE_MS = 30_000;
const INIT_RETRY_COOLDOWN_MS = 10_000;

const DEFAULT_REQUIREMENTS = ["numpy", "pandas", "httpx"] as const;

function buildBaseContainer(client: Client): Container {
  // no shared uv cache volume: agent code runs as this same user and could
  // tamper with a cross-tenant cache. cross-run reuse comes from Dagger's
  // layer cache (the warmed base and per-requirement-set install execs).
  return client
    .container()
    .from(config.codeRuntime.image)
    .withWorkdir(WORKDIR)
    .withUser(NON_ROOT_USER)
    .withEnvVariable("HOME", WORKDIR);
}

function warmBaseContainer(container: Container): Container {
  return container
    .withExec(["uv", "venv", VENV_DIR])
    .withExec([
      "uv",
      "pip",
      "install",
      "--python",
      VENV_PYTHON,
      ...DEFAULT_REQUIREMENTS,
    ]);
}

const CapturedRunSchema = z.object({
  exitCode: z.number().int(),
  stderr: z.string(),
  stdout: z.string(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
});

function parseCapturedRun(raw: string): CapturedRun {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new CodeRuntimeError("the code runtime returned invalid JSON");
  }

  const result = CapturedRunSchema.safeParse(decoded);
  if (!result.success) {
    throw new CodeRuntimeError("the code runtime returned an invalid result");
  }
  return result.data;
}

function validateRunParams(params: RunCodeParams): ValidatedRunParams {
  const codeBytes = Buffer.byteLength(params.code, "utf8");
  if (codeBytes > CODE_RUNTIME_LIMITS.maxCodeBytes) {
    throw new CodeRuntimeError(
      `code is too large (${formatBytes(codeBytes)} > ${formatBytes(CODE_RUNTIME_LIMITS.maxCodeBytes)})`,
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
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (!normalized) {
      throw new CodeRuntimeError(`requirement ${index + 1} is empty`);
    }
    if (bytes > CODE_RUNTIME_LIMITS.maxRequirementBytes) {
      throw new CodeRuntimeError(
        `requirement ${index + 1} is too large (${formatBytes(bytes)} > ${formatBytes(CODE_RUNTIME_LIMITS.maxRequirementBytes)})`,
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

function buildRunnerArgs(timeoutSeconds: number): string[] {
  return [
    "python3",
    `${WORKDIR}/${RUNNER_FILE}`,
    String(timeoutSeconds),
    String(config.codeRuntime.maxOutputBytes),
    String(CODE_RUNTIME_LIMITS.maxCpuSeconds),
    String(CODE_RUNTIME_LIMITS.maxMemoryBytes),
    String(CODE_RUNTIME_LIMITS.maxProcesses),
    RESULT_FILE,
    WORKDIR,
    VENV_PYTHON,
    SCRIPT_FILE,
  ];
}

/** turns a failed `uv pip install` into a normal non-zero run result. */
function capturedInstallFailure(exitCode: number, stderr: string): CapturedRun {
  const limit = config.codeRuntime.maxOutputBytes;
  const overLimit = Buffer.byteLength(stderr, "utf8") > limit;
  return {
    stdout: "",
    stderr: overLimit
      ? `${stderr.slice(0, limit)}\n...[output truncated]`
      : stderr,
    exitCode,
    truncated: overLimit,
    timedOut: false,
  };
}

function formatBytes(bytes: number): string {
  return `${bytes} bytes`;
}

async function raceWithTimeout(
  work: Promise<unknown>,
  ms: number,
): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([work.then(() => "done" as const), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
