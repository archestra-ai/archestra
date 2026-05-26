import {
  type Client,
  type ConnectOpts,
  type Container,
  connect,
  ReturnType as DaggerReturnType,
} from "@dagger.io/dagger";
import config from "@/config";
import logger from "@/logging";
import {
  SkillFileModel,
  SkillModel,
  SkillSandboxArtifactModel,
  SkillSandboxCommandModel,
  SkillSandboxModel,
} from "@/models";
import type { Skill, SkillFile, SkillSandbox } from "@/types";
import { asSandboxId, type SandboxId } from "@/types";
import {
  SKILL_SANDBOX_ROOT,
  SKILL_SANDBOX_USER,
  skillRootPath,
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
  private client: Client | null = null;
  private initPromise: Promise<void> | null = null;
  private sessionPromise: Promise<void> | null = null;
  private stopSession: (() => void) | null = null;
  private lastInitAttemptAt = 0;
  private activeRuns = 0;
  private readonly waiters: Array<() => void> = [];

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
      const client = this.client;
      if (!client) {
        this.status = "error";
        throw new SkillSandboxError(
          "the skill sandbox runtime is not available (engine unreachable)",
        );
      }

      const materialized = await this.materializeWithReplay({
        client,
        sandbox,
      });
      const wrapped = wrapWithTimeout({
        command: params.command,
        cwd,
        timeoutSeconds,
        outputBytesLimit: config.skillsSandbox.outputBytesLimit,
      });
      const executed = materialized.withExec(["bash", "-c", wrapped], {
        expect: DaggerReturnType.Any,
      });
      const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
        executed.stdout(),
        executed.stderr(),
        executed.exitCode(),
      ]);
      const stdout = truncateOutput(
        stdoutRaw,
        config.skillsSandbox.outputBytesLimit,
      );
      const stderr = truncateOutput(
        stderrRaw,
        config.skillsSandbox.outputBytesLimit,
      );
      const durationMs = Date.now() - startedAt;
      const timedOut = exitCode === TIMEOUT_EXIT_CODE;

      const row = await SkillSandboxCommandModel.append({
        sandboxId: params.sandboxId,
        command: params.command,
        cwd: params.cwd ?? null,
        stdout: stdout.value,
        stderr: stderr.value,
        exitCode,
        durationMs,
      });

      return {
        commandId: row.id,
        sandboxId: params.sandboxId,
        command: params.command,
        cwd: params.cwd ?? null,
        stdout: stdout.value,
        stderr: stderr.value,
        exitCode,
        durationMs,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      };
    } catch (error) {
      throw await this.normalizeError(error);
    } finally {
      this.release();
    }
  }

  /**
   * Materializes the sandbox, replays the command log, reads the requested
   * file as bytes, and persists it to `skill_sandbox_artifacts`.
   */
  async exportArtifact(params: ExportArtifactParams): Promise<ArtifactRef> {
    this.ensureEnabled();
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
      const client = this.client;
      if (!client) {
        this.status = "error";
        throw new SkillSandboxError(
          "the skill sandbox runtime is not available (engine unreachable)",
        );
      }

      const materialized = await this.materializeWithReplay({
        client,
        sandbox,
      });
      // `base64 -w0` collapses the file into one line for clean capture; this
      // works for binary contents that `.file(...).contents()` cannot expose
      // directly because the Dagger File API returns strings only.
      const encoder = materialized.withExec(
        ["bash", "-c", `base64 -w0 ${shellQuote(resolvedPath)}`],
        { expect: DaggerReturnType.Any },
      );
      const [base64Stdout, exitCode, stderr] = await Promise.all([
        encoder.stdout(),
        encoder.exitCode(),
        encoder.stderr(),
      ]);
      if (exitCode !== 0) {
        throw new SkillSandboxError(
          `failed to read artifact at ${resolvedPath}: ${stderr.trim() || `exit ${exitCode}`}`,
        );
      }
      const data = Buffer.from(base64Stdout.trim(), "base64");
      if (data.byteLength > config.skillsSandbox.artifactBytesLimit) {
        throw new SkillSandboxError(
          `artifact at ${resolvedPath} is too large (${data.byteLength} bytes > ${config.skillsSandbox.artifactBytesLimit})`,
        );
      }

      const row = await SkillSandboxArtifactModel.create({
        sandboxId: params.sandboxId,
        path: resolvedPath,
        mimeType: params.mimeType ?? "application/octet-stream",
        sizeBytes: data.byteLength,
        data,
      });

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
  }

  async shutdown(): Promise<void> {
    if (this.status !== "disabled") {
      this.status = "stopped";
    }
    await this.closeDaggerSession();
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

  private async materializeWithReplay(params: {
    client: Client;
    sandbox: SkillSandbox;
  }): Promise<Container> {
    const base = await this.materialize(params);
    const log = await SkillSandboxCommandModel.listBySandbox(params.sandbox.id);
    let container = base;
    for (const entry of log) {
      const cwd = entry.cwd ?? params.sandbox.defaultCwd;
      const wrapped = wrapWithTimeout({
        command: entry.command,
        cwd,
        timeoutSeconds: config.skillsSandbox.wallClockSeconds,
        outputBytesLimit: config.skillsSandbox.outputBytesLimit,
      });
      // replays accept any exit code so prior failures do not block the new
      // command; Dagger's layer cache keeps repeat replays fast.
      container = container.withExec(["bash", "-c", wrapped], {
        expect: DaggerReturnType.Any,
      });
    }
    return container;
  }

  private async materialize(params: {
    client: Client;
    sandbox: SkillSandbox;
  }): Promise<Container> {
    const skillIds = await SkillSandboxModel.listSkillIds(params.sandbox.id);
    const skills = await loadSkillsById(skillIds);
    const skillsById = new Map(skills.map((s) => [s.id, s]));

    let container = this.buildBaseContainer({
      client: params.client,
      image: params.sandbox.baseImage,
      defaultCwd: params.sandbox.defaultCwd,
    });

    for (const skillId of skillIds) {
      const skill = skillsById.get(skillId);
      if (!skill) {
        throw new SkillSandboxError(
          `sandbox ${params.sandbox.id} references missing skill ${skillId}`,
        );
      }
      container = await mountSkillFiles({
        container,
        skill,
      });
    }
    return container;
  }

  private buildBaseContainer(params: {
    client: Client;
    image: string;
    defaultCwd: string;
  }): Container {
    return params.client
      .container()
      .from(params.image)
      .withUser(SKILL_SANDBOX_USER)
      .withEnvVariable("HOME", SKILL_SANDBOX_ROOT)
      .withEnvVariable("SKILL_SANDBOX_ROOT", SKILL_SANDBOX_ROOT)
      .withWorkdir(params.defaultCwd);
  }

  private async doInit(): Promise<void> {
    if (!config.skillsSandbox.enabled) {
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
        resolveReady();
        await sessionClosed;
      } catch (error) {
        rejectReady(error);
        throw error;
      } finally {
        if (this.client === client) {
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

    this.status = "error";
    await this.closeDaggerSession();
    logger.error(
      { err: error },
      "[SkillSandboxRuntime] Dagger execution failed",
    );
    return new SkillSandboxError(
      "the skill sandbox runtime is not available (engine unreachable)",
    );
  }

  private async closeDaggerSession(): Promise<void> {
    this.client = null;
    this.stopSession?.();
    await this.sessionPromise?.catch((error) => {
      logger.error(
        { err: error },
        "[SkillSandboxRuntime] Dagger session failed",
      );
    });
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

/** Synthetic exit code emitted by GNU `timeout` when the wall clock fires. */
const TIMEOUT_EXIT_CODE = 124;
const INIT_RETRY_COOLDOWN_MS = 10_000;
const DAGGER_CONNECT_OPTS = {
  LoadWorkspaceModules: false,
  Workdir: "/",
} satisfies ConnectOpts;

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

async function loadSkillsById(skillIds: string[]): Promise<Skill[]> {
  if (skillIds.length === 0) return [];
  const skills: Skill[] = [];
  for (const id of skillIds) {
    const skill = await SkillModel.findById(id);
    if (skill) skills.push(skill);
  }
  return skills;
}

async function mountSkillFiles(params: {
  container: Container;
  skill: Skill;
}): Promise<Container> {
  const files = await SkillFileModel.findBySkillId(params.skill.id);
  const root = skillRootPath(params.skill.name);
  let container = params.container.withNewFile(
    `${root}/SKILL.md`,
    params.skill.content,
  );
  for (const file of files) {
    container = applySkillFile({
      container,
      root,
      file,
    });
  }
  return container;
}

function applySkillFile(params: {
  container: Container;
  root: string;
  file: SkillFile;
}): Container {
  const target = `${params.root}/${params.file.path}`;
  switch (params.file.encoding) {
    case "utf8":
      return params.container.withNewFile(target, params.file.content);
    case "base64": {
      // Dagger has no direct byte upload — stage the base64 string in a temp
      // file and decode it in-place so binary assets land verbatim.
      const tempPath = `${target}.b64`;
      return params.container
        .withNewFile(tempPath, params.file.content)
        .withExec(
          [
            "bash",
            "-c",
            `mkdir -p $(dirname ${shellQuote(target)}) && base64 -d ${shellQuote(tempPath)} > ${shellQuote(target)} && rm ${shellQuote(tempPath)}`,
          ],
          { expect: DaggerReturnType.Any },
        );
    }
  }
}

function wrapWithTimeout(params: {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  outputBytesLimit: number;
}): string {
  const cd = `cd ${shellQuote(params.cwd)}`;
  const head = `head -c ${params.outputBytesLimit}`;
  return `${cd} && timeout --preserve-status --signal=KILL ${params.timeoutSeconds}s bash -c ${shellQuote(params.command)} 2> >(${head} >&2) | ${head}`;
}

function truncateOutput(
  raw: string,
  limit: number,
): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= limit) {
    return { value: raw, truncated: false };
  }
  return {
    value: `${raw.slice(0, limit)}\n...[output truncated]`,
    truncated: true,
  };
}

function resolveArtifactPath(params: {
  path: string;
  defaultCwd: string;
}): string {
  if (params.path.startsWith("/")) return params.path;
  const cwd = params.defaultCwd.endsWith("/")
    ? params.defaultCwd.slice(0, -1)
    : params.defaultCwd;
  return `${cwd}/${params.path}`;
}

/** Quote a single shell argument with single quotes, escaping embedded quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** @public — exported for tests */
export const __internals = {
  shellQuote,
  truncateOutput,
  resolveArtifactPath,
  wrapWithTimeout,
  asSandboxId,
};
