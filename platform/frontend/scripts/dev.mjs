import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const VALID = new Set(["turbopack", "webpack"]);

/**
 * Choose the Next.js dev bundler. Turbopack compiles 2-6x faster, but
 * @next/swc-darwin-arm64 leaks multi-GB non-reclaimable IOAccelerator (Apple
 * GPU) memory under Turbopack on Apple Silicon (vercel/next.js#92055, still
 * open), so macOS arm64 stays on webpack until the upstream native fix ships.
 * Set ARCHESTRA_DEV_BUNDLER=turbopack|webpack to override.
 */
export function pickBundler({ override, platform, arch }) {
  if (override) {
    if (!VALID.has(override)) {
      throw new Error(
        `ARCHESTRA_DEV_BUNDLER must be "turbopack" or "webpack" (got "${override}")`,
      );
    }
    return override;
  }
  return platform === "darwin" && arch === "arm64" ? "webpack" : "turbopack";
}

function main() {
  let bundler;
  try {
    bundler = pickBundler({
      override: process.env.ARCHESTRA_DEV_BUNDLER,
      platform: process.platform,
      arch: process.arch,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const require = createRequire(import.meta.url);
  const nextPkg = require("next/package.json");
  const nextBin = join(
    dirname(require.resolve("next/package.json")),
    typeof nextPkg.bin === "string" ? nextPkg.bin : nextPkg.bin.next,
  );

  const child = spawn(
    process.execPath,
    [nextBin, "dev", `--${bundler}`, "-H", "127.0.0.1", ...process.argv.slice(2)],
    { stdio: "inherit" },
  );

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  child.on("exit", (code, signal) => {
    if (signal) {
      // Re-raise with our handlers removed so the default disposition terminates
      // this process with the same signal the child died from — otherwise the
      // still-installed handler swallows it and we'd exit 0, hiding the
      // interruption from callers (Tilt, the shell).
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  main();
}
