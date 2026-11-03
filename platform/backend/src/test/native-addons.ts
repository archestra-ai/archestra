import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Before a backend test run, make sure the NAPI addons the backend loads
 * (`@archestra/*-rs`, one package directory each under platform/archestra-rs)
 * are in place. Their compiled `.node` files are gitignored and `pnpm install`
 * never builds them (install scripts are off), so a checkout nobody prepared,
 * such as a code review's, has none, and every test that reaches one fails
 * with `Unable to load @archestra/<crate>`. A checkout Tilt, the lite stack or
 * CI prepared has every addon, and this costs it a directory read per crate.
 *
 * When an addon is missing, or was installed for another archestra-rs tree,
 * scripts/napi-prebuilt.mjs installs the ones CI published for this tree: a
 * download of about 20 MB, a few seconds. Nothing here compiles: a cargo build
 * takes minutes and gigabytes, which a small Agent Runtime pod does not have.
 * When the addons cannot be installed, the tests still run; only those that
 * load an addon fail, as they did before, and the message says how to build.
 */

export type NativeAddonsOutcome =
  /** Every crate has an addon for this tree; nothing ran. */
  | "present"
  /** The installer put the published addons in place. */
  | "installed"
  /** Some addon is still missing: no published build, no network, another platform. */
  | "unavailable"
  /** ARCHESTRA_DEV_NAPI_PREBUILT=false and some addon is missing. */
  | "disabled";

export type NativeAddonsResult = {
  outcome: NativeAddonsOutcome;
  /** The crates with no addon for this platform after the attempt. */
  missing: string[];
};

/** Where an addon is loaded: the loader picks the file by platform and libc. */
export type AddonTarget = {
  platform: NodeJS.Platform;
  arch: string;
  musl: boolean;
};

export type EnsureNativeAddonsOptions = {
  /** platform/backend: its package.json names the crates. */
  backendDir: string;
  /** platform/archestra-rs */
  rustDir: string;
  /** platform/scripts/napi-prebuilt.mjs */
  installer: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** How long the installer may take, lock wait and download included. */
  timeoutMs?: number;
  /** The platform the addons are loaded on; the running one by default. */
  target?: AddonTarget;
  /** Earlier answers in this process, by crate directory; the process-wide map by default. */
  cache?: Map<string, NativeAddonsResult>;
  /** The clock, for the retry interval after a failed install. */
  now?: () => number;
};

/**
 * The installer waits up to five minutes for another installer's lock, then
 * thirty seconds for the registry and five minutes for the download; this
 * only stops a hang beyond its own limits.
 */
const DEFAULT_INSTALL_TIMEOUT_MS = 12 * 60_000;

/** A failed install is not retried for this long, unless the tree changes. */
const RETRY_AFTER_MS = 10 * 60_000;

/** Written by the installer beside each addon: `<key> <sha256>`. */
const STAMP = ".napi-prebuilt";

/** Written here after a failed install: `<key> <epoch ms>`. */
const UNAVAILABLE_MARKER = ".napi-prebuilt.unavailable";

/**
 * Vitest evaluates the config once per project (five times for the backend),
 * so the answer for a crate directory is kept for the rest of the process:
 * one install attempt and one message per run.
 */
export function ensureNativeAddons(
  options: EnsureNativeAddonsOptions,
): NativeAddonsResult {
  const { rustDir, cache = processCache() } = options;
  let result = cache.get(rustDir);
  if (!result) {
    result = ensureNativeAddonsOnce(options);
    cache.set(rustDir, result);
  }
  return result;
}

function ensureNativeAddonsOnce(
  options: EnsureNativeAddonsOptions,
): NativeAddonsResult {
  const {
    backendDir,
    rustDir,
    installer,
    env = process.env,
    log = (line) => console.error(line),
    timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
    target = runningTarget(),
    now = Date.now,
  } = options;
  const crates = nativeAddonCrates(backendDir);
  let missing = missingAddons(rustDir, crates, target);
  // The key names the tree the published addons were built from. Outside a
  // git checkout there is none, and an addon that exists is taken as is.
  const key =
    missing.length > 0 || hasStamps(rustDir, crates)
      ? prebuiltKey(rustDir)
      : undefined;
  const stale = key ? staleAddons(rustDir, crates, key) : [];
  if (missing.length === 0 && stale.length === 0) {
    return { outcome: "present", missing };
  }
  if (env.ARCHESTRA_DEV_NAPI_PREBUILT === "false") {
    if (missing.length > 0) {
      log(
        `native addons: ${hint(missing)} (ARCHESTRA_DEV_NAPI_PREBUILT=false skips the published ones)`,
      );
    }
    return { outcome: missing.length > 0 ? "disabled" : "present", missing };
  }
  // Addons stamped for another tree are refreshed only on a clean tree: on a
  // modified one the installer refuses anyway, and the binaries are the
  // developer's own builds of the change in progress.
  if (missing.length === 0 && !treeIsClean(rustDir)) {
    return { outcome: "present", missing };
  }
  const failedAt = key ? recentFailure(rustDir, key, now()) : undefined;
  if (failedAt !== undefined) {
    const minutes = Math.max(1, Math.round((now() - failedAt) / 60_000));
    log(
      `native addons: ${hint(missing)} (the prebuilt install failed ${minutes} min ago; it is retried after ${RETRY_AFTER_MS / 60_000} min, or sooner when the archestra-rs tree changes)`,
    );
    return { outcome: "unavailable", missing };
  }
  // The installer installs every crate from one download, whichever subset is
  // asked for, refuses a modified tree, and says what it did on stderr. Its
  // exit status alone is not the answer: the files are.
  const result = spawnSync(process.execPath, [installer, ...crates], {
    env,
    stdio: ["ignore", "inherit", "inherit"],
    timeout: timeoutMs,
  });
  missing = missingAddons(rustDir, crates, target);
  if (missing.length === 0) return { outcome: "installed", missing };
  if (result.error) {
    const reason =
      (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
        ? `gave up after ${timeoutMs / 1000} s`
        : result.error.message;
    log(`native addons: the prebuilt installer ${reason}`);
  }
  if (key) rememberFailure(rustDir, key, now());
  log(`native addons: ${hint(missing)}`);
  return { outcome: "unavailable", missing };
}

/** The crates whose addons the backend loads: its `@archestra/*-rs` dependencies. */
export function nativeAddonCrates(backendDir: string): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(backendDir, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  return Object.keys(manifest.dependencies ?? {})
    .map((name) => /^@archestra\/(.+-rs)$/.exec(name)?.[1])
    .filter((crate): crate is string => crate !== undefined)
    .sort();
}

/** The crates with no addon the loader would pick on this target. */
export function missingAddons(
  rustDir: string,
  crates: readonly string[],
  target: AddonTarget = runningTarget(),
): string[] {
  return crates.filter(
    (crate) =>
      !addonCandidates(crate, target).some((name) =>
        existsSync(path.join(rustDir, crate, name)),
      ),
  );
}

/**
 * The files the loader (archestra-rs/napi-loader) tries for a crate on a
 * target, in its order: a file for another platform does not count.
 */
export function addonCandidates(crate: string, target: AddonTarget): string[] {
  const crateName = crate.replaceAll("-", "_");
  const libc = target.musl ? "musl" : "gnu";
  const triples: Record<string, string> = {
    "darwin:arm64": "darwin-arm64",
    "darwin:x64": "darwin-x64",
    "linux:arm64": `linux-arm64-${libc}`,
    "linux:x64": `linux-x64-${libc}`,
  };
  const triple = triples[`${target.platform}:${target.arch}`];
  return [
    ...(triple ? [`${crateName}.${triple}.node`, `index.${triple}.node`] : []),
    `${crateName}.node`,
    "index.node",
  ];
}

export function runningTarget(): AddonTarget {
  // As the loader decides: a Linux without a glibc runtime is musl.
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  return {
    platform: process.platform,
    arch: process.arch,
    musl: process.platform === "linux" && !report?.header?.glibcVersionRuntime,
  };
}

/**
 * The key the installer tags published addons with: the archestra-rs tree and
 * the toolchain, lockfile and workflow blobs (see cacheKey there). Undefined
 * outside a git checkout.
 */
export function prebuiltKey(rustDir: string): string | undefined {
  try {
    const [tree, toolchain, lockfile, recipe] = execFileSync(
      "git",
      [
        "rev-parse",
        "HEAD:platform/archestra-rs",
        "HEAD:platform/rust-toolchain.toml",
        "HEAD:platform/pnpm-lock.yaml",
        "HEAD:.github/workflows/napi-dev-cache.yml",
      ],
      { cwd: rustDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split("\n");
    if (!tree || !toolchain || !lockfile || !recipe) return undefined;
    return [tree, toolchain, lockfile, recipe]
      .map((id, i) => (i ? id.slice(0, 12) : id))
      .join("-");
  } catch {
    return undefined;
  }
}

/** The crates whose addon the installer stamped for another tree. */
export function staleAddons(
  rustDir: string,
  crates: readonly string[],
  key: string,
): string[] {
  return crates.filter((crate) => {
    const stamp = readStamp(rustDir, crate);
    return stamp !== undefined && stamp !== key;
  });
}

function hasStamps(rustDir: string, crates: readonly string[]): boolean {
  return crates.some((crate) => readStamp(rustDir, crate) !== undefined);
}

/** The key in a crate's installer stamp, or undefined without one. */
function readStamp(rustDir: string, crate: string): string | undefined {
  try {
    return readFileSync(path.join(rustDir, crate, STAMP), "utf8")
      .trim()
      .split(" ")[0];
  } catch {
    return undefined;
  }
}

/** Whether archestra-rs and the toolchain file are as committed, like the installer checks. */
function treeIsClean(rustDir: string): boolean {
  try {
    return (
      execFileSync(
        "git",
        [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          ".",
          "../rust-toolchain.toml",
        ],
        { cwd: rustDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim() === ""
    );
  } catch {
    return false;
  }
}

/** When the last install for this key failed, if within the retry interval. */
function recentFailure(
  rustDir: string,
  key: string,
  now: number,
): number | undefined {
  try {
    const [failedKey, at] = readFileSync(
      path.join(rustDir, UNAVAILABLE_MARKER),
      "utf8",
    )
      .trim()
      .split(" ");
    const failedAt = Number(at);
    if (failedKey !== key || !Number.isFinite(failedAt)) return undefined;
    return now - failedAt < RETRY_AFTER_MS ? failedAt : undefined;
  } catch {
    return undefined;
  }
}

function rememberFailure(rustDir: string, key: string, now: number): void {
  try {
    writeFileSync(path.join(rustDir, UNAVAILABLE_MARKER), `${key} ${now}\n`);
  } catch {
    // A read-only checkout just retries next time.
  }
}

// The config module is re-evaluated per project, so a module variable would
// not survive; a global keyed by symbol does.
const CACHE_KEY = Symbol.for("archestra.backend.nativeAddons");

function processCache(): Map<string, NativeAddonsResult> {
  const host = globalThis as { [CACHE_KEY]?: Map<string, NativeAddonsResult> };
  host[CACHE_KEY] ??= new Map();
  return host[CACHE_KEY];
}

function hint(missing: readonly string[]): string {
  const builds = missing
    .map((crate) => `pnpm --dir archestra-rs/${crate} build:dev`)
    .join(" && ");
  return `no addon for ${missing.join(", ")}; tests that load one fail with "Unable to load @archestra/<crate>". Build them from platform/ with: ${builds}`;
}
