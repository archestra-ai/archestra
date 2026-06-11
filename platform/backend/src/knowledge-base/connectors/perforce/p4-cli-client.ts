import { execFile } from "node:child_process";
import type pino from "pino";
import config from "@/config";

/**
 * Minimal client for the Perforce `p4` CLI.
 *
 * Perforce has no official Node.js API and no generally-available REST API,
 * so the standard server-side integration is shelling out to the `p4` binary
 * (the same approach official CI integrations take). All metadata commands run
 * with `-ztag -Mj` (line-delimited JSON) so output parsing needs no custom
 * format handling; `print` runs raw and captures file bytes from stdout.
 *
 * No client workspace is required: `files`, `changes`, `print`, and `info`
 * all operate on depot syntax.
 *
 * Security properties:
 * - spawned via `execFile` (argv array, no shell)
 * - the password/ticket reaches the child only through the `P4PASSWD`
 *   environment variable, never argv
 * - the child environment is an allowlist, not an inherited copy
 * - the password/ticket value is redacted from every thrown error message
 */
export class P4CliClient {
  private p4Port: string;
  private username: string;
  private password: string;
  private log: pino.Logger;

  constructor(params: {
    p4Port: string;
    username: string;
    password: string;
    log: pino.Logger;
  }) {
    assertNoControlCharacters("P4PORT", params.p4Port);
    assertNoControlCharacters("username", params.username);
    this.p4Port = params.p4Port;
    this.username = params.username;
    this.password = params.password;
    this.log = params.log;
  }

  /** `p4 info` — connectivity probe; returns the raw tagged record. */
  async info(): Promise<Record<string, unknown>> {
    const records = await this.runTagged(["info"]);
    const stat = records.find((record) => record.code === "stat");
    if (!stat) {
      throw new P4CommandError("p4 info returned no server information");
    }
    return stat;
  }

  /**
   * `p4 changes -m1 -s submitted <spec>` — highest submitted changelist
   * affecting the filespec (with its submit time, when reported), or null
   * when the path has no submitted changes (e.g. an empty or non-existent
   * depot path).
   */
  async latestChange(
    filespec: string,
  ): Promise<{ change: number; time?: string } | null> {
    const records = await this.runTagged([
      "changes",
      "-m1",
      "-s",
      "submitted",
      filespec,
    ]);
    const stat = records.find((record) => record.code === "stat");
    if (!stat) return null;
    const change = Number.parseInt(String(stat.change), 10);
    if (Number.isNaN(change)) {
      throw new P4CommandError(
        `p4 changes returned a non-numeric changelist: ${String(stat.change)}`,
      );
    }
    // `time` is epoch seconds in tagged output.
    const timeSeconds = Number.parseInt(String(stat.time ?? ""), 10);
    return {
      change,
      time: Number.isNaN(timeSeconds)
        ? undefined
        : new Date(timeSeconds * 1000).toISOString(),
    };
  }

  /**
   * `p4 files -e <specs...>` — depot files matching the filespecs at their
   * given revision specifiers. `-e` excludes deleted/purged/archived files.
   * Returns an empty array when nothing matches.
   */
  async files(
    filespecs: string[],
    options?: { max?: number },
  ): Promise<P4DepotFile[]> {
    if (filespecs.length === 0) return [];
    const maxArgs =
      options?.max !== undefined ? ["-m", String(options.max)] : [];
    const records = await this.runTagged([
      "files",
      "-e",
      ...maxArgs,
      ...filespecs,
    ]);
    return records
      .filter((record) => record.code === "stat")
      .map((record) => ({
        depotFile: String(record.depotFile),
        rev: Number.parseInt(String(record.rev), 10),
        change: Number.parseInt(String(record.change), 10),
        action: String(record.action),
        type: String(record.type),
      }));
  }

  /**
   * `p4 print -q <spec>` — file content at the given revision specifier.
   * Throws {@link P4FileTooLargeError} when the file exceeds the stdout cap.
   */
  async print(filespec: string): Promise<string> {
    try {
      const { stdout } = await this.execP4(
        [...this.globalArgs(), "print", "-q", filespec],
        { maxBuffer: MAX_PRINT_BYTES },
      );
      return stdout;
    } catch (error) {
      if (isMaxBufferError(error)) {
        throw new P4FileTooLargeError(filespec, MAX_PRINT_BYTES);
      }
      throw this.toCommandError(error);
    }
  }

  // ===== Private methods =====

  /** Run a metadata command with `-ztag -Mj` and parse one JSON record per line. */
  private async runTagged(
    args: string[],
  ): Promise<Array<Record<string, unknown>>> {
    let stdout: string;
    try {
      ({ stdout } = await this.execP4(
        [...this.globalArgs(), "-ztag", "-Mj", ...args],
        { maxBuffer: MAX_TAGGED_OUTPUT_BYTES },
      ));
    } catch (error) {
      // p4 may exit non-zero even when stdout only carries benign warning
      // records (e.g. "no such file(s)" for an empty path). Recover those so
      // they flow through the normal severity handling below.
      const benignStdout = recoverBenignFailureStdout(error);
      if (benignStdout === null) {
        throw this.toCommandError(error);
      }
      stdout = benignStdout;
    }

    const records: Array<Record<string, unknown>> = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new P4CommandError(
          `Unexpected non-JSON output from p4 ${args[0]}: ${this.redact(truncate(trimmed))}`,
        );
      }
      if (parsed === null || typeof parsed !== "object") {
        throw new P4CommandError(
          `Unexpected p4 ${args[0]} record shape: ${this.redact(truncate(trimmed))}`,
        );
      }
      records.push(parsed as Record<string, unknown>);
    }

    this.assertNoErrorRecords(args[0], records);
    return records;
  }

  /**
   * p4 emits failures as `code: "error"` records on stdout. Severity 3+
   * (E_FAILED/E_FATAL) is a real failure; "no such file(s)" warnings simply
   * mean an empty result for the given filespec.
   */
  private assertNoErrorRecords(
    command: string,
    records: Array<Record<string, unknown>>,
  ): void {
    for (const record of records) {
      if (record.code !== "error") continue;
      const data = String(record.data ?? "");
      const severity = Number(record.severity ?? 0);
      if (severity >= P4_SEVERITY_FAILED) {
        throw new P4CommandError(
          `p4 ${command} failed: ${this.redact(truncate(data))}`,
        );
      }
      if (NO_MATCHING_FILES_PATTERN.test(data)) continue;
      this.log.warn(
        { command, message: this.redact(truncate(data)) },
        "p4 reported a warning",
      );
    }
  }

  private globalArgs(): string[] {
    return ["-p", this.p4Port, "-u", this.username];
  }

  private execP4(
    args: string[],
    options: { maxBuffer: number },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        config.kb.p4BinaryPath,
        args,
        {
          env: this.childEnv(),
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: options.maxBuffer,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(Object.assign(error, { stdout, stderr }));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }

  /**
   * Allowlisted child environment. `P4TRUST` / `P4TICKETS` / `P4CHARSET` pass
   * through from the backend process so deployments can pre-provision SSL
   * trust, ticket files, or a charset for unicode-mode servers.
   */
  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      P4PASSWD: this.password,
    };
    for (const key of ["PATH", "HOME", "P4TRUST", "P4TICKETS", "P4CHARSET"]) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
    return env;
  }

  private toCommandError(error: unknown): Error {
    if (
      error instanceof P4CommandError ||
      error instanceof P4FileTooLargeError
    ) {
      return error;
    }
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (err.code === "ENOENT") {
      return new P4CommandError(
        `Perforce CLI binary not found at "${config.kb.p4BinaryPath}". ` +
          "Install the p4 client in the backend image or set ARCHESTRA_KNOWLEDGE_BASE_P4_BINARY_PATH.",
      );
    }
    if (err.killed) {
      return new P4CommandError(
        `p4 command timed out after ${COMMAND_TIMEOUT_MS}ms`,
      );
    }
    const detail =
      extractErrorRecordData(err.stdout) ||
      err.stderr?.trim() ||
      err.message ||
      "unknown error";
    return new P4CommandError(
      `p4 command failed: ${this.redact(truncate(detail))}`,
    );
  }

  private redact(text: string): string {
    if (!this.password) return text;
    return text.split(this.password).join("***");
  }
}

/** A depot file as reported by `p4 files`. */
export interface P4DepotFile {
  depotFile: string;
  rev: number;
  change: number;
  action: string;
  type: string;
}

export class P4CommandError extends Error {}

export class P4FileTooLargeError extends Error {
  constructor(filespec: string, maxBytes: number) {
    super(
      `File exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB indexing limit: ${filespec}`,
    );
  }
}

/**
 * Errors that indicate the server connection or authentication is broken —
 * these abort a sync instead of being recorded as per-file failures.
 */
export function isConnectionLevelError(error: unknown): boolean {
  if (!(error instanceof P4CommandError)) return false;
  return CONNECTION_ERROR_PATTERN.test(error.message);
}

// ===== Internal helpers =====

const COMMAND_TIMEOUT_MS = 30_000;
/** Cap for `-ztag -Mj` metadata output (file listings of large depots). */
const MAX_TAGGED_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Per-file content cap for `p4 print`; larger files are skipped. */
const MAX_PRINT_BYTES = 2 * 1024 * 1024;
/** Perforce message severities: 0 empty, 1 info, 2 warn, 3 failed, 4 fatal. */
const P4_SEVERITY_FAILED = 3;
const NO_MATCHING_FILES_PATTERN =
  /no such file\(s\)|no file\(s\) matching|file\(s\) not in client view/i;
const CONNECTION_ERROR_PATTERN =
  /connect to server failed|tcp connect|connection refused|timed out|password \(p4passwd\) invalid|password invalid|not logged in|ticket expired|please login|binary not found/i;

function assertNoControlCharacters(label: string, value: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\x00-\x1f]/.test(value)) {
    throw new P4CommandError(`${label} contains control characters`);
  }
}

function isMaxBufferError(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException)?.code ===
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}

/**
 * When a non-zero p4 exit produced stdout consisting solely of parseable
 * tagged records whose error entries are all below FAILED severity, return
 * that stdout for normal record handling; otherwise null (a real failure).
 *
 * Only genuine process exits qualify: transport failures (ENOENT, timeout
 * kill, maxBuffer overflow) carry string codes or `killed` and must never be
 * recovered — a maxBuffer-truncated listing can end on a complete JSON line
 * and would otherwise pass for a full result.
 */
function recoverBenignFailureStdout(error: unknown): string | null {
  const err = error as NodeJS.ErrnoException & {
    stdout?: string;
    killed?: boolean;
  };
  if (typeof err.code !== "number" || err.killed) return null;
  const stdout = err.stdout;
  if (!stdout?.trim()) return null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.code === "error" &&
      Number(record.severity ?? 0) >= P4_SEVERITY_FAILED
    ) {
      return null;
    }
  }
  return stdout;
}

/** Pull the message out of a `code: "error"` JSON record when present. */
function extractErrorRecordData(stdout: string | undefined): string | null {
  if (!stdout) return null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      if (record.code === "error" && typeof record.data === "string") {
        return record.data.trim();
      }
    } catch {
      // Raw (non -Mj) output — fall through to stderr/message.
      return null;
    }
  }
  return null;
}

function truncate(text: string, maxLength = 500): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
