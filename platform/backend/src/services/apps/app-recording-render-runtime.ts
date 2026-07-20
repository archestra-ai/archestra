import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import config from "@/config";
import logger from "@/logging";
import { ApiError } from "@/types";

const exec = promisify(execFile);

/**
 * Finds — and if necessary installs — the Chromium a video render drives.
 *
 * A browser is ~285 MB and only deployments that turn the recorder on ever
 * render anything, so it is not baked into the image. It is fetched the first
 * time it is needed and, when the recorder is enabled, warmed at boot so the
 * first export does not wait for a download. Nothing here asks an operator to
 * install or configure anything.
 *
 * Two ways to get one, because the two environments cannot share a build:
 * Alpine images are musl, which Playwright ships no browser for, so those use
 * the distro package; everywhere else uses Playwright's own download, which is
 * usually already present from a dev install.
 *
 * It must be a FULL Chromium, never Playwright's headless shell — the shell
 * carries no WebCodecs encoder and the render encodes H.264 inside the browser.
 */
interface RenderRuntime {
  chromiumPath: string;
  /** How it was obtained, for the log line that explains a slow first render. */
  source: "configured" | "playwright" | "system";
}

/**
 * Resolve the browser, installing it if this deployment has none yet.
 * Concurrent callers share one install — a package manager takes a global lock,
 * and a second export arriving mid-download would otherwise fail on it.
 */
export function ensureRenderRuntime(): Promise<RenderRuntime> {
  inFlight ??= resolveOrInstall().catch((error) => {
    // A failed install must not poison every later attempt: a transient
    // network failure should be retried by the next export.
    inFlight = null;
    throw error;
  });
  return inFlight;
}

/**
 * Start fetching the browser in the background. Called at boot when the
 * recorder is enabled, so the first export is not the one that pays for it.
 */
export function warmRenderRuntime(): void {
  if (!config.hackathonRecorder.enabled) return;
  void ensureRenderRuntime().then(
    (runtime) => logger.info(runtime, "App session video rendering is ready"),
    (error) =>
      logger.warn(
        { err: error },
        "Could not prepare app session video rendering; the first export will retry",
      ),
  );
}

// =============================================================================
// Internal helpers
// =============================================================================

let inFlight: Promise<RenderRuntime> | null = null;

/** Chromium plus the faces a recorded chat actually renders with. */
const APK_PACKAGES = [
  "chromium",
  "ttf-liberation",
  "font-noto",
  "font-noto-emoji",
];

/** Where a distro or a base image usually puts a full Chromium. */
const SYSTEM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

/** Downloading a browser over a slow link is not a 30-second operation. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

async function resolveOrInstall(): Promise<RenderRuntime> {
  const found = await resolve();
  if (found) return found;

  logger.info("Installing Chromium for app session video rendering");
  await install();

  const installed = await resolve();
  if (!installed) {
    throw new ApiError(
      503,
      "Video export installed Chromium but could not find it afterwards.",
    );
  }
  return installed;
}

async function resolve(): Promise<RenderRuntime | null> {
  const configured = config.hackathonRecorder.chromiumPath;
  if (configured && (await isExecutable(configured))) {
    return { chromiumPath: configured, source: "configured" };
  }
  const downloaded = playwrightExecutablePath();
  if (downloaded && (await isExecutable(downloaded))) {
    return { chromiumPath: downloaded, source: "playwright" };
  }
  for (const candidate of SYSTEM_CANDIDATES) {
    if (await isExecutable(candidate)) {
      return { chromiumPath: candidate, source: "system" };
    }
  }
  return null;
}

async function install(): Promise<void> {
  // Alpine: Playwright has no musl build, so the distro package is the only
  // browser that will actually run here. The font packages are not optional —
  // Chromium's own dependencies bring a single face, which leaves serif, sans
  // and monospace identical and renders emoji and CJK as empty boxes in the
  // exported video.
  if (await isExecutable("/sbin/apk")) {
    await run("/sbin/apk", ["add", "--no-cache", ...APK_PACKAGES]);
    return;
  }
  // Everywhere else: Playwright fetches the build it already knows how to
  // drive, into the same cache a dev install would have populated.
  const cli = playwrightCliPath();
  if (!cli) {
    throw new ApiError(
      503,
      "Video export needs Chromium and this deployment has no way to install it.",
    );
  }
  await run(process.execPath, [cli, "install", "chromium"]);
}

async function run(command: string, args: string[]): Promise<void> {
  try {
    await exec(command, args, {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    logger.error({ err: error, command, args }, "Failed to install Chromium");
    throw new ApiError(
      503,
      "Video export could not install Chromium. Check that this deployment has network access.",
    );
  }
}

/**
 * Both of these reach into `playwright-core`, which is optional at runtime:
 * a deployment that never renders a video should not fail to boot over it.
 */
function playwrightExecutablePath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return require("playwright-core").chromium.executablePath() || null;
  } catch {
    return null;
  }
}

function playwrightCliPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("playwright-core/cli.js");
  } catch {
    return null;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
