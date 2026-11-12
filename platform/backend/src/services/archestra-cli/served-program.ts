import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import { registerProcessLocalCache } from "@/process-local-cache-registry";

/**
 * A target as a request names it: as `uname -s` and `uname -m` print them
 * ("Darwin-arm64", "Linux-aarch64"), or "windows-" and PROCESSOR_ARCHITECTURE
 * ("windows-AMD64"). For a route schema: every method here that takes a target
 * accepts the same names.
 */
export function programTargetPattern(): RegExp {
  return TARGET_PATTERN;
}

/** One file of the download folder: the program for one target. */
interface ServedProgramFile {
  path: string;
  size: number;
  /** When the file last changed, in milliseconds. */
  changedAtMs: number;
  /** The name the program has on the user's computer. */
  downloadName: string;
}

/** What a tunnel client says about the program it runs, as it sent it. */
export interface ReportedProgramValues {
  version: string | null;
  target: string | null;
  sha256: string | null;
}

/**
 * What a tunnel client reported about its program, with every value that is
 * missing or not valid as null: a version of at most 32 printable characters,
 * a known target in the spelling of the files, and a SHA-256 in lower-case
 * hex.
 */
export function parseReportedProgram(
  reported: ReportedProgramValues,
): ReportedProgramValues {
  const version = reported.version?.trim() ?? "";
  return {
    version: PROGRAM_VERSION_PATTERN.test(version) ? version : null,
    target: reported.target ? parseProgramTarget(reported.target) : null,
    sha256:
      reported.sha256 && SHA256_PATTERN.test(reported.sha256)
        ? reported.sha256
        : null,
  };
}

/**
 * The `archestra` programs this deployment serves: the files of the download
 * folder, one per target, and `manifest.json` with their version.
 */
class ServedProgramService {
  /**
   * The SHA-256 of each served file, by its path, size and time of change: a
   * file that is replaced gets a new entry, and the old one ages out. Holds
   * the promise, so requests that come together read the file once.
   */
  private checksums = registerProcessLocalCache(
    new LRUCacheManager<Promise<string>>({
      // More than the targets of one folder, so a replaced file does not
      // push the others out.
      maxSize: 32,
      // No time limit: the key changes when the file does.
      defaultTtl: 0,
    }),
  );

  /** The file for a target, or null when this deployment has none. */
  async findFile(target: string): Promise<ServedProgramFile | null> {
    const parsed = splitTarget(target);
    if (!parsed) return null;
    const suffix = PROGRAM_SUFFIX_BY_SYSTEM[parsed.system];
    const file = path.join(
      config.archestraCli.downloadDir,
      `archestra-${parsed.system}-${parsed.cpu}${suffix}`,
    );
    const stats = await stat(file).catch(() => null);
    if (!stats?.isFile()) return null;
    return {
      path: file,
      size: stats.size,
      changedAtMs: stats.mtimeMs,
      downloadName: `archestra${suffix}`,
    };
  }

  /**
   * The program this deployment serves for a target: its version, from the
   * manifest (null with no valid manifest, as on a dev stack with a
   * hand-built program), and the SHA-256 of the file itself. Null when the
   * target is missing or not known, or when there is no file for it.
   */
  async getServedProgram(
    target: string | null,
  ): Promise<{ version: string | null; sha256: string } | null> {
    const file = target ? await this.findFile(target) : null;
    if (!file) return null;
    const [version, sha256] = await Promise.all([
      this.readVersion(),
      // A file that went away or cannot be read is a file that is not there.
      this.checksum(file).catch(() => null),
    ]);
    return sha256 === null ? null : { version, sha256 };
  }

  private checksum(file: ServedProgramFile): Promise<string> {
    const key = `${file.path}\n${file.size}\n${file.changedAtMs}`;
    const cached = this.checksums.get(key);
    if (cached) return cached;
    const computed = sha256OfFile(file.path);
    this.checksums.set(key, computed);
    // A read that failed is not kept: the next request reads the file again.
    computed.catch(() => {
      this.checksums.delete(key);
    });
    return computed;
  }

  /** The version of the served programs, or null with no valid manifest. */
  private async readVersion(): Promise<string | null> {
    const text = await readFile(
      path.join(config.archestraCli.downloadDir, MANIFEST_FILE),
      "utf8",
    ).catch(() => null);
    if (text === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const manifest = ManifestSchema.safeParse(json);
    return manifest.success ? manifest.data.version : null;
  }
}

export const servedProgramService = new ServedProgramService();

// === Internal helpers

const MANIFEST_FILE = "manifest.json";

/** A version: at most 32 printable ASCII characters. */
const PROGRAM_VERSION_PATTERN = /^[\x20-\x7e]{1,32}$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const ManifestSchema = z.object({
  version: z.string().trim().regex(PROGRAM_VERSION_PATTERN),
});

/**
 * The systems with a program, in lower case as `uname -s` prints them, and
 * the end of the file name of their program. Windows has no `uname`: the
 * PowerShell command of the Connect page sends "windows".
 */
const PROGRAM_SUFFIX_BY_SYSTEM = {
  darwin: "",
  linux: "",
  windows: ".exe",
} as const;

type System = keyof typeof PROGRAM_SUFFIX_BY_SYSTEM;

/**
 * `uname -m` and Windows' PROCESSOR_ARCHITECTURE (`AMD64`, `ARM64`) spell some
 * CPUs differently; the files use one name.
 */
const CPU_BY_NAME = {
  arm64: "arm64",
  aarch64: "arm64",
  x86_64: "x86_64",
  amd64: "x86_64",
} as const;

type Cpu = (typeof CPU_BY_NAME)[keyof typeof CPU_BY_NAME];

const TARGET_PATTERN = new RegExp(
  `^(${Object.keys(PROGRAM_SUFFIX_BY_SYSTEM).join("|")})-(${Object.keys(CPU_BY_NAME).join("|")})$`,
  "i",
);

/**
 * The target a name means, in the one spelling the files and the device rows
 * use (`darwin-arm64`), or null for a name that is not a target.
 */
function parseProgramTarget(target: string): string | null {
  const parsed = splitTarget(target);
  return parsed ? `${parsed.system}-${parsed.cpu}` : null;
}

function splitTarget(target: string): { system: System; cpu: Cpu } | null {
  if (!TARGET_PATTERN.test(target)) return null;
  const [system, cpuName] = target.toLowerCase().split("-") as [
    System,
    keyof typeof CPU_BY_NAME,
  ];
  return { system, cpu: CPU_BY_NAME[cpuName] };
}

/** Reads the file as a stream: a program is tens of megabytes. */
async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}
