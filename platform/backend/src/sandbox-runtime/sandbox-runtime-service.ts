import type { EnvironmentTarget, ReplayEntry } from "@archestra/sandbox-rs";
import {
  context as otelContext,
  propagation as otelPropagation,
} from "@opentelemetry/api";
import config from "@/config";
import logger from "@/logging";
import * as metrics from "@/observability/metrics";

// lazy-load the native addon: importing this module for codegen / openapi
// generation, or running with the runtime disabled, must not require the
// platform-specific `.node` binary to be present.
type NativeBindings = typeof import("@archestra/sandbox-rs");
let nativeBindings: Promise<NativeBindings> | null = null;
function loadNative(): Promise<NativeBindings> {
  nativeBindings ??= import("@archestra/sandbox-rs");
  return nativeBindings;
}

export type SandboxRuntimeStatus =
  | "disabled"
  | "initializing"
  | "ready"
  | "error"
  | "stopped";

export class SandboxRuntimeError extends Error {
  readonly code: NativeSandboxErrorCode;
  constructor(
    message: string,
    code: NativeSandboxErrorCode = "ARCHESTRA_INTERNAL",
  ) {
    super(message);
    this.name = "SandboxRuntimeError";
    this.code = code;
  }
}

type NativeSandboxErrorCode =
  | "ARCHESTRA_ARTIFACT_NOT_FOUND"
  | "ARCHESTRA_ARTIFACT_TOO_LARGE"
  | "ARCHESTRA_COMMAND_FAILED"
  | "ARCHESTRA_ENGINE_UNREACHABLE"
  | "ARCHESTRA_INTERNAL"
  | "ARCHESTRA_INVALID_INPUT";

interface LimitOverrides {
  outputBytesLimit?: number;
  fileSizeLimitBytes?: number;
  cpuSeconds?: number;
  memoryBytes?: number;
}

interface RunCommandParams extends LimitOverrides {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  replayEntries?: ReplayEntry[];
  /**
   * The environment isolation target. When set, the native session pool runs
   * this command on that environment's engine; omitted uses the process-default
   * engine.
   */
  environment?: EnvironmentTarget;
}

interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

interface ReadArtifactParams extends LimitOverrides {
  path: string;
  /**
   * cwd a replayed entry with no stored cwd should default to. mirrors the
   * sandbox's `defaultCwd` so artifact extraction replays land in the same
   * directory as the original run.
   */
  defaultCwd: string;
  replayEntries?: ReplayEntry[];
  /**
   * The environment isolation target. Artifact extraction replays the recorded
   * commands, so it must run on the same per-environment engine the sandbox ran
   * on (else the replay bypasses the environment's egress policy).
   */
  environment?: EnvironmentTarget;
}

interface ReadArtifactResult {
  dataBase64: string;
  sizeBytes: number;
}

/**
 * Process-singleton sandbox runtime — every shell command (skill sandbox or
 * python script) flows through this service. The native side keeps one
 * long-lived session with a pre-warmed base container, so per-call overhead is
 * dominated by the command itself rather than session/image setup. The backend
 * is currently Dagger; this wrapper is the seam where another could slot in.
 */
interface Waiter {
  resolve: () => void;
  reject: (err: SandboxRuntimeError) => void;
}

class SandboxRuntimeService {
  private status: SandboxRuntimeStatus = "disabled";
  private initPromise: Promise<void> | null = null;
  private lastInitAttemptAt = 0;
  private activeRuns = 0;
  private readonly waiters: Waiter[] = [];
  // consumers attached to the shared service. shutdown only fires when the
  // last consumer detaches, so one adapter can't tear down a runtime that
  // the other one still depends on.
  private readonly consumers = new Set<string>();

  get isEnabled(): boolean {
    return config.daggerRuntime.enabled;
  }

  get isReady(): boolean {
    return this.status === "ready";
  }

  // Cached boot status for the /ready healthcheck. Never triggers init() or
  // checkSession() — the poller reads a frozen snapshot, so an `error` here is
  // terminal (nothing re-runs the 10s retry during a readiness poll).
  get bootStatus(): SandboxRuntimeStatus {
    return this.status;
  }

  async init(): Promise<void> {
    if (!config.daggerRuntime.enabled) {
      this.setStatus("disabled");
      return;
    }
    if (this.status === "ready") return;
    // shutdown is terminal — drainWaiters has already rejected callers as
    // unreachable, so re-running doInit would silently revive a runtime no
    // consumer registered for and contradict the consumer reference-count.
    if (this.status === "stopped") return;
    if (this.initPromise) return this.initPromise;

    const now = Date.now();
    if (
      this.status === "error" &&
      now - this.lastInitAttemptAt < INIT_RETRY_COOLDOWN_MS
    ) {
      return;
    }

    this.initPromise = this.doInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  async runCommand(params: RunCommandParams): Promise<RunCommandResult> {
    await this.ensureReady();
    const { runSandbox } = await loadNative();
    await this.acquire();
    try {
      return await this.withBackstop(params.timeoutSeconds, () =>
        runSandbox({
          traceparent: getTraceparent(),
          replayEntries: params.replayEntries ?? [],
          limits: this.limits(params),
          command: params.command,
          cwd: params.cwd,
          timeoutSeconds: params.timeoutSeconds,
          environment: params.environment,
        }),
      );
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      this.release();
    }
  }

  async readArtifact(params: ReadArtifactParams): Promise<ReadArtifactResult> {
    await this.ensureReady();
    const { readArtifact } = await loadNative();
    await this.acquire();
    try {
      return await this.withBackstop(ARTIFACT_BUDGET_SECONDS, () =>
        readArtifact({
          traceparent: getTraceparent(),
          replayEntries: params.replayEntries ?? [],
          limits: this.limits(params),
          path: params.path,
          defaultCwd: params.defaultCwd,
          environment: params.environment,
        }),
      );
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      this.release();
    }
  }

  /** attach a consumer (adapter) to the shared runtime. */
  async attach(consumerId: string): Promise<void> {
    this.consumers.add(consumerId);
    await this.init();
  }

  /** detach a consumer. only shuts down the runtime when the last one leaves. */
  async detach(consumerId: string): Promise<void> {
    this.consumers.delete(consumerId);
    if (this.consumers.size === 0) {
      await this.shutdown();
    }
  }

  async shutdown(): Promise<void> {
    if (this.status === "disabled") return;
    this.setStatus("stopped");
    this.drainWaiters(
      new SandboxRuntimeError(
        "the sandbox runtime is shutting down",
        "ARCHESTRA_ENGINE_UNREACHABLE",
      ),
    );
    // best-effort flush of the native OTLP batch so the last spans/logs aren't
    // lost on process exit. force_flush is idempotent, so it's safe even when
    // shutdown fires on the last consumer detaching mid-process. only meaningful
    // if the addon was ever loaded (telemetry inits lazily on first sandbox use).
    if (nativeBindings) {
      try {
        const native = await nativeBindings;
        await native.flushTelemetry();
      } catch (error) {
        logger.warn({ error }, "sandbox-rs telemetry flush failed");
      }
    }
  }

  // === private ===

  /**
   * Single seam for every status transition. Mirrors the gauge to the new
   * status (1 for current, 0 for others) so the engine `error` window is
   * graphable. Purely additive — no change to transition logic.
   */
  private setStatus(next: SandboxRuntimeStatus): void {
    this.status = next;
    metrics.sandbox.reportRuntimeStatus({ status: next });
  }

  private async ensureReady(): Promise<void> {
    if (!config.daggerRuntime.enabled) {
      throw new SandboxRuntimeError(
        "the sandbox runtime is not enabled",
        "ARCHESTRA_INVALID_INPUT",
      );
    }
    await this.init();
    switch (this.status) {
      case "stopped":
        throw new SandboxRuntimeError(
          "the sandbox runtime has been stopped",
          "ARCHESTRA_ENGINE_UNREACHABLE",
        );
      case "ready":
        return;
      default:
        throw new SandboxRuntimeError(
          "the sandbox runtime is not available (engine unreachable)",
          "ARCHESTRA_ENGINE_UNREACHABLE",
        );
    }
  }

  private async doInit(): Promise<void> {
    if (!config.daggerRuntime.enabled) {
      this.setStatus("disabled");
      return;
    }
    this.applyDaggerEnv();
    this.lastInitAttemptAt = Date.now();
    this.setStatus("initializing");

    try {
      const { checkSession } = await loadNative();
      await checkSession({ traceparent: getTraceparent() });
      // shutdown() may have fired while we were awaiting; don't revive it.
      // re-read status as the union type since TS narrows past the await.
      if ((this.status as SandboxRuntimeStatus) === "stopped") return;
      this.setStatus("ready");
      logger.info("[SandboxRuntime] ready — shared session + warm base online");
    } catch (error) {
      if ((this.status as SandboxRuntimeStatus) !== "stopped") {
        this.setStatus("error");
      }
      logger.error(
        { err: error },
        "[SandboxRuntime] failed to initialize — sandbox execution unavailable",
      );
      throw error;
    }
  }

  private applyDaggerEnv(): void {
    const { runnerHost, cliBin } = config.daggerRuntime;
    if (runnerHost) {
      process.env._EXPERIMENTAL_DAGGER_RUNNER_HOST = runnerHost;
    }
    if (cliBin) {
      process.env._EXPERIMENTAL_DAGGER_CLI_BIN = cliBin;
    }
  }

  private limits(overrides?: LimitOverrides) {
    const { defaults } = config.daggerRuntime;
    return {
      outputBytesLimit:
        overrides?.outputBytesLimit ?? defaults.outputBytesLimit,
      fileSizeLimitBytes:
        overrides?.fileSizeLimitBytes ?? defaults.fileSizeLimitBytes,
      cpuSeconds: overrides?.cpuSeconds ?? defaults.cpuSeconds,
      memoryBytes: overrides?.memoryBytes ?? defaults.memoryBytes,
    };
  }

  private async acquire(): Promise<void> {
    if (this.activeRuns < config.daggerRuntime.maxConcurrent) {
      this.activeRuns++;
      return;
    }
    if (this.waiters.length >= config.daggerRuntime.maxQueueLength) {
      throw new SandboxRuntimeError(
        "the sandbox runtime is at capacity — too many runs are already queued",
        "ARCHESTRA_ENGINE_UNREACHABLE",
      );
    }
    await new Promise<void>((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
    } else {
      this.activeRuns--;
    }
  }

  private drainWaiters(err: SandboxRuntimeError): void {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.reject(err);
    }
  }

  /**
   * JS-side backstop: if the native call doesn't return within the request's
   * own budget plus a config buffer, assume the engine is wedged. The buffer
   * has to cover cold-image pull + warm-base build for the very first request.
   */
  private async withBackstop<T>(
    budgetSeconds: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const totalMs = (budgetSeconds + NATIVE_BACKSTOP_BUFFER_SECONDS) * 1000;
    let backstopHandle: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        backstopHandle = setTimeout(() => {
          if (this.status !== "stopped") this.setStatus("error");
          // Count it here: the rejection below is already a SandboxRuntimeError,
          // so normalizeError short-circuits and never reaches its
          // engine_unreachable counter for the backstop path.
          metrics.sandbox.reportRuntimeError({ code: "engine_unreachable" });
          logger.error(
            { totalMs },
            "[SandboxRuntime] native call exceeded backstop — engine assumed wedged",
          );
          reject(
            new SandboxRuntimeError(
              "the sandbox runtime native call did not return within the backstop window",
              "ARCHESTRA_ENGINE_UNREACHABLE",
            ),
          );
        }, totalMs);
        fn().then(resolve, reject);
      });
    } finally {
      if (backstopHandle) clearTimeout(backstopHandle);
    }
  }

  private normalizeError(error: unknown): SandboxRuntimeError {
    if (error instanceof SandboxRuntimeError) return error;
    const native = getNativeSandboxError(error);
    switch (native.code) {
      case "ARCHESTRA_ARTIFACT_NOT_FOUND":
      case "ARCHESTRA_ARTIFACT_TOO_LARGE":
      case "ARCHESTRA_COMMAND_FAILED":
      case "ARCHESTRA_INVALID_INPUT":
        return new SandboxRuntimeError(native.message, native.code);
      case "ARCHESTRA_ENGINE_UNREACHABLE":
        // genuine engine outage — flip status so the cooldown gate kicks in.
        // never overwrite 'stopped': shutdown is the terminal state and
        // late-arriving errors must not silently re-enable retries.
        if (this.status !== "stopped") this.setStatus("error");
        metrics.sandbox.reportRuntimeError({ code: "engine_unreachable" });
        logger.error(
          { err: error, code: native.code },
          "[SandboxRuntime] engine unreachable",
        );
        return new SandboxRuntimeError(
          "the sandbox runtime is not available (engine unreachable)",
          "ARCHESTRA_ENGINE_UNREACHABLE",
        );
      case "ARCHESTRA_INTERNAL":
      case null:
        // per-call failure that doesn't necessarily mean the engine is gone.
        // surface the original message and leave runtime status untouched.
        metrics.sandbox.reportRuntimeError({ code: "internal" });
        logger.warn(
          { err: error, code: native.code },
          "[SandboxRuntime] execution failed",
        );
        return new SandboxRuntimeError(
          native.message || "the sandbox runtime call failed",
          "ARCHESTRA_INTERNAL",
        );
    }
  }
}

export const sandboxRuntimeService = new SandboxRuntimeService();

const INIT_RETRY_COOLDOWN_MS = 10_000;
// artifact reads have no per-call timeout; cap their backstop budget here.
const ARTIFACT_BUDGET_SECONDS = 60;
// extra wall-clock budget added to a request's own timeout before the JS-side
// backstop assumes the engine is wedged. has to cover the first request's cold
// image pull + warm-base build, so it's generous; not an operator-facing knob.
const NATIVE_BACKSTOP_BUFFER_SECONDS = 180;

function getTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  otelPropagation.inject(otelContext.active(), carrier);
  return carrier.traceparent;
}

function getNativeSandboxError(error: unknown): {
  code: NativeSandboxErrorCode | null;
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
    case "ARCHESTRA_COMMAND_FAILED":
    case "ARCHESTRA_ENGINE_UNREACHABLE":
    case "ARCHESTRA_INTERNAL":
    case "ARCHESTRA_INVALID_INPUT":
      return { code, message: error.message };
    default:
      return { code: null, message: error.message };
  }
}
