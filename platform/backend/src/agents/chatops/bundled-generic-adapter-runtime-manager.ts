import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import logger from "@/logging";
import {
  ApiError,
  type BundledChatOpsAdapterId,
  type BundledChatOpsAdapterRuntimeStatus,
  type BundledChatOpsAdapterSummary,
} from "@/types";
import {
  type BundledGenericAdapterCatalogEntry,
  bundledGenericAdapterCatalog,
} from "./bundled-generic-adapter-catalog";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESS_EXIT_TIMEOUT_MS = 1000;

type FileAccess = typeof access;
type PackageFileRead = typeof readFile;
type SpawnProcess = typeof spawn;

interface RuntimeState {
  status: BundledChatOpsAdapterRuntimeStatus;
  pid: number | null;
  lastStartedAt: string | null;
  lastExitAt: string | null;
  errorMessage: string | null;
  intentionallyStopping: boolean;
}

export function resolvePlatformRootFrom(startPath: string): string {
  const resolvedStartPath = path.resolve(startPath);
  const discoveredRoot =
    findPlatformRoot(resolvedStartPath) ?? findPlatformRoot(process.cwd());

  if (!discoveredRoot) {
    throw new Error(
      `Unable to resolve platform root from ${resolvedStartPath}`,
    );
  }

  return discoveredRoot;
}

function findPlatformRoot(startPath: string): string | null {
  let currentPath = path.resolve(startPath);

  while (true) {
    if (isPlatformRoot(currentPath)) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

function isPlatformRoot(candidatePath: string): boolean {
  return (
    existsSync(path.join(candidatePath, "pnpm-workspace.yaml")) &&
    existsSync(path.join(candidatePath, "backend", "package.json"))
  );
}

const DEFAULT_PLATFORM_ROOT = resolvePlatformRootFrom(__dirname);

export class BundledGenericAdapterRuntimeManager {
  private readonly catalog: readonly BundledGenericAdapterCatalogEntry[];
  private readonly workspaceRootPath: string;
  private readonly fileAccess: FileAccess;
  private readonly packageFileRead: PackageFileRead;
  private readonly spawnProcess: SpawnProcess;
  private readonly runtimeStates = new Map<
    BundledChatOpsAdapterId,
    RuntimeState
  >();
  private readonly childProcesses = new Map<
    BundledChatOpsAdapterId,
    ChildProcess
  >();

  constructor(options?: {
    catalog?: readonly BundledGenericAdapterCatalogEntry[];
    workspaceRootPath?: string;
    fileAccess?: FileAccess;
    packageFileRead?: PackageFileRead;
    spawnProcess?: SpawnProcess;
  }) {
    this.catalog = options?.catalog ?? bundledGenericAdapterCatalog;
    this.workspaceRootPath =
      options?.workspaceRootPath ?? DEFAULT_PLATFORM_ROOT;
    this.fileAccess = options?.fileAccess ?? access;
    this.packageFileRead = options?.packageFileRead ?? readFile;
    this.spawnProcess = options?.spawnProcess ?? spawn;
  }

  async initialize(): Promise<void> {
    for (const entry of this.catalog) {
      if (!this.runtimeStates.has(entry.adapterId)) {
        this.runtimeStates.set(entry.adapterId, this.createInitialState());
      }
    }
  }

  listSummaries(): BundledChatOpsAdapterSummary[] {
    return this.catalog.map((entry) => this.getSummary(entry.adapterId));
  }

  async stopAdapter(
    adapterId: BundledChatOpsAdapterId,
  ): Promise<BundledChatOpsAdapterSummary> {
    this.getCatalogEntry(adapterId);
    await this.stopProcess(adapterId);
    return this.getSummary(adapterId);
  }

  getCatalogEntry(
    adapterId: BundledChatOpsAdapterId,
  ): BundledGenericAdapterCatalogEntry {
    const entry = this.catalog.find((item) => item.adapterId === adapterId);

    if (!entry) {
      throw new ApiError(404, `Unknown bundled adapter ${adapterId}`);
    }

    return entry;
  }

  getConnectionPageConfig(
    adapterId: BundledChatOpsAdapterId,
  ): { port: number } | null {
    const entry = this.getCatalogEntry(adapterId);
    return entry.connectionPage ?? null;
  }

  async startAdapter(
    adapterId: BundledChatOpsAdapterId,
  ): Promise<BundledChatOpsAdapterSummary> {
    const entry = this.getCatalogEntry(adapterId);
    const existingProcess = this.childProcesses.get(adapterId);

    if (
      existingProcess &&
      existingProcess.exitCode === null &&
      existingProcess.signalCode === null
    ) {
      return this.getSummary(adapterId);
    }

    const workingDirectory = this.resolvePackagePath(entry);
    const entrypointPath = path.resolve(
      workingDirectory,
      entry.launch.entrypointRelativePath,
    );

    await this.ensureEntrypointAvailable(
      entry,
      workingDirectory,
      entrypointPath,
    );

    this.updateRuntimeState(adapterId, {
      status: "starting",
      pid: null,
      errorMessage: null,
      intentionallyStopping: false,
    });

    const child = this.spawnProcess(
      process.execPath,
      ["--enable-source-maps", entrypointPath, ...(entry.launch.args ?? [])],
      {
        cwd: workingDirectory,
        env: {
          ...process.env,
          ...(entry.launch.env ?? {}),
          ...(entry.connectionPage
            ? { CONNECTION_SERVER_PORT: String(entry.connectionPage.port) }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.childProcesses.set(adapterId, child);
    this.attachProcessLogging(adapterId, child);

    return await new Promise<BundledChatOpsAdapterSummary>(
      (resolve, reject) => {
        let settled = false;

        const resolveOnce = () => {
          if (settled) return;
          settled = true;
          resolve(this.getSummary(adapterId));
        };

        const rejectOnce = (error: ApiError) => {
          if (settled) return;
          settled = true;
          reject(error);
        };

        child.once("spawn", async () => {
          this.updateRuntimeState(adapterId, {
            status: "running",
            pid: child.pid ?? null,
            lastStartedAt: new Date().toISOString(),
            errorMessage: null,
            intentionallyStopping: false,
          });

          if (entry.connectionPage) {
            try {
              await this.waitForConnectionPageHealth(entry.connectionPage.port);
            } catch {
              logger.warn(
                { adapterId },
                "[ChatOps] Timed out waiting for connection page health check",
              );
            }
          }

          resolveOnce();
        });

        child.once("error", (error) => {
          this.childProcesses.delete(adapterId);
          this.updateRuntimeState(adapterId, {
            status: "error",
            pid: null,
            lastExitAt: new Date().toISOString(),
            errorMessage: error.message,
            intentionallyStopping: false,
          });
          rejectOnce(
            new ApiError(
              500,
              `Failed to start bundled adapter ${adapterId}: ${error.message}`,
            ),
          );
        });

        child.once("exit", (code, signal) => {
          this.childProcesses.delete(adapterId);

          const state =
            this.runtimeStates.get(adapterId) ?? this.createInitialState();
          const wasIntentional = state.intentionallyStopping;
          const wasCleanExit =
            wasIntentional || (code === 0 && signal === null);

          this.updateRuntimeState(adapterId, {
            status: wasCleanExit ? "stopped" : "error",
            pid: null,
            lastExitAt: new Date().toISOString(),
            errorMessage: wasCleanExit
              ? null
              : this.buildExitMessage(adapterId, code, signal),
            intentionallyStopping: false,
          });

          if (!settled && !wasIntentional) {
            rejectOnce(
              new ApiError(
                500,
                `Bundled adapter ${adapterId} exited before it became ready.`,
              ),
            );
          }
        });
      },
    );
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.catalog.map(async (entry) => {
        await this.stopProcess(entry.adapterId);
      }),
    );
  }

  getSummary(adapterId: BundledChatOpsAdapterId): BundledChatOpsAdapterSummary {
    const entry = this.getCatalogEntry(adapterId);
    const state =
      this.runtimeStates.get(adapterId) ?? this.createInitialState();

    return {
      adapterId: entry.adapterId,
      displayName: entry.displayName,
      description: entry.description,
      status: state.status,
      pid: state.pid,
      lastStartedAt: state.lastStartedAt,
      lastExitAt: state.lastExitAt,
      errorMessage: state.errorMessage,
      hasConnectionPage: Boolean(entry.connectionPage),
    };
  }

  private resolvePackagePath(entry: BundledGenericAdapterCatalogEntry): string {
    return path.resolve(
      this.workspaceRootPath,
      entry.launch.packageRelativePath,
    );
  }

  private async ensureEntrypointAvailable(
    entry: BundledGenericAdapterCatalogEntry,
    workingDirectory: string,
    entrypointPath: string,
  ): Promise<void> {
    if (await this.entrypointExists(entrypointPath)) {
      if (await this.isEntrypointStale(workingDirectory, entrypointPath)) {
        logger.info(
          { adapterId: entry.adapterId },
          "[ChatOps] Bundled adapter source is newer than entrypoint, rebuilding",
        );
        await this.buildAdapter(entry, workingDirectory);
      }

      return;
    }

    await this.buildAdapter(entry, workingDirectory);

    if (await this.entrypointExists(entrypointPath)) {
      return;
    }

    throw new ApiError(
      409,
      `Bundled adapter ${entry.adapterId} is not built yet. Missing ${entry.launch.entrypointRelativePath}.`,
    );
  }

  private async entrypointExists(entrypointPath: string): Promise<boolean> {
    try {
      await this.fileAccess(entrypointPath);
      return true;
    } catch {
      return false;
    }
  }

  private async isEntrypointStale(
    workingDirectory: string,
    entrypointPath: string,
  ): Promise<boolean> {
    let entrypointMtime: number;
    try {
      entrypointMtime = (await stat(entrypointPath)).mtimeMs;
    } catch {
      return true;
    }

    const srcDir = path.resolve(workingDirectory, "src");
    return getNewestMtimeMs(srcDir) > entrypointMtime;
  }

  private async buildAdapter(
    entry: BundledGenericAdapterCatalogEntry,
    workingDirectory: string,
  ): Promise<void> {
    const buildCommand = await this.getBuildCommand(entry, workingDirectory);
    const { command, args } = this.getShellInvocation(buildCommand);

    logger.info(
      { adapterId: entry.adapterId, buildCommand, workingDirectory },
      "[ChatOps] Bundled adapter entrypoint missing, attempting build",
    );

    await new Promise<void>((resolve, reject) => {
      const buildProcess = this.spawnProcess(command, args, {
        cwd: workingDirectory,
        env: this.createBuildEnv(workingDirectory),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buildOutput = "";

      const appendOutput = (chunk: Buffer | string) => {
        const message = chunk.toString().trim();
        if (!message) return;
        buildOutput = buildOutput ? `${buildOutput}\n${message}` : message;
      };

      buildProcess.stdout?.on("data", appendOutput);
      buildProcess.stderr?.on("data", appendOutput);

      buildProcess.once("error", (error) => {
        reject(
          new ApiError(
            500,
            `Failed to build bundled adapter ${entry.adapterId}: ${error.message}`,
          ),
        );
      });

      buildProcess.once("exit", (code, signal) => {
        if (code === 0 && signal === null) {
          resolve();
          return;
        }

        const exitReason = signal
          ? `signal ${signal}`
          : `code ${code ?? "unknown"}`;
        reject(
          new ApiError(
            500,
            buildOutput
              ? `Failed to build bundled adapter ${entry.adapterId}: process exited with ${exitReason}. ${buildOutput}`
              : `Failed to build bundled adapter ${entry.adapterId}: process exited with ${exitReason}.`,
          ),
        );
      });
    });
  }

  private async getBuildCommand(
    entry: BundledGenericAdapterCatalogEntry,
    workingDirectory: string,
  ): Promise<string> {
    const packageJsonPath = path.resolve(workingDirectory, "package.json");

    let packageJsonContent: string;
    try {
      packageJsonContent = await this.packageFileRead(packageJsonPath, "utf8");
    } catch (error) {
      throw new ApiError(
        500,
        `Failed to read bundled adapter manifest for ${entry.adapterId}: ${this.getErrorMessage(error)}`,
      );
    }

    let buildCommand: string | undefined;
    try {
      const packageJson = JSON.parse(packageJsonContent) as {
        scripts?: {
          build?: string;
        };
      };
      buildCommand = packageJson.scripts?.build;
    } catch {
      throw new ApiError(
        500,
        `Failed to parse bundled adapter manifest for ${entry.adapterId}.`,
      );
    }

    if (!buildCommand) {
      throw new ApiError(
        500,
        `Bundled adapter ${entry.adapterId} does not define a build script.`,
      );
    }

    return buildCommand;
  }

  private getShellInvocation(buildCommand: string): {
    command: string;
    args: string[];
  } {
    if (process.platform === "win32") {
      return {
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", buildCommand],
      };
    }

    return {
      command: "/bin/sh",
      args: ["-lc", buildCommand],
    };
  }

  private createBuildEnv(workingDirectory: string): NodeJS.ProcessEnv {
    const localBinPath = path.resolve(workingDirectory, "node_modules", ".bin");
    const pathKey =
      Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
      "PATH";
    const currentPath = process.env[pathKey] ?? "";

    return {
      ...process.env,
      [pathKey]: [localBinPath, currentPath]
        .filter(Boolean)
        .join(path.delimiter),
    };
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private updateRuntimeState(
    adapterId: BundledChatOpsAdapterId,
    updates: Partial<RuntimeState>,
  ) {
    const current =
      this.runtimeStates.get(adapterId) ?? this.createInitialState();
    this.runtimeStates.set(adapterId, {
      ...current,
      ...updates,
    });
  }

  private createInitialState(): RuntimeState {
    return {
      status: "stopped",
      pid: null,
      lastStartedAt: null,
      lastExitAt: null,
      errorMessage: null,
      intentionallyStopping: false,
    };
  }

  private async stopProcess(adapterId: BundledChatOpsAdapterId): Promise<void> {
    const child = this.childProcesses.get(adapterId);

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.childProcesses.delete(adapterId);
      this.updateRuntimeState(adapterId, {
        status: "stopped",
        pid: null,
        errorMessage: null,
        intentionallyStopping: false,
      });
      return;
    }

    this.updateRuntimeState(adapterId, { intentionallyStopping: true });

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, PROCESS_EXIT_TIMEOUT_MS);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      child.kill("SIGTERM");
    });
  }

  private attachProcessLogging(
    adapterId: BundledChatOpsAdapterId,
    child: ChildProcess,
  ) {
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const message = chunk.toString().trim();
      if (!message) return;
      logger.info(
        { adapterId, output: message },
        "[ChatOps] Bundled adapter stdout",
      );
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const message = chunk.toString().trim();
      if (!message) return;
      logger.warn(
        { adapterId, output: message },
        "[ChatOps] Bundled adapter stderr",
      );
    });
  }

  private buildExitMessage(
    adapterId: BundledChatOpsAdapterId,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): string {
    if (signal) {
      return `Bundled adapter ${adapterId} exited with signal ${signal}`;
    }

    return `Bundled adapter ${adapterId} exited with code ${code ?? "unknown"}`;
  }

  private async waitForConnectionPageHealth(
    port: number,
    timeoutMs = 10_000,
    intervalMs = 200,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) return;
      } catch {
        // not ready yet
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new Error(
      `Timed out waiting for connection page health on port ${port}`,
    );
  }
}

function getNewestMtimeMs(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, getNewestMtimeMs(fullPath));
    } else if (entry.isFile()) {
      newest = Math.max(newest, statSync(fullPath).mtimeMs);
    }
  }
  return newest;
}

export const bundledGenericAdapterRuntimeManager =
  new BundledGenericAdapterRuntimeManager();
