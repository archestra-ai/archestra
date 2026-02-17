#!/usr/bin/env node
/**
 * Dev script: build once, run tsdown --watch and node dist/server.mjs in parallel.
 * Cross-platform (no rm -rf or concurrently dependency).
 */
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// 1. Clear dist
try {
  const dist = join(root, "dist");
  if (existsSync(dist)) rmSync(dist, { recursive: true });
} catch (_) {}

// 2. Build once (tsdown)
const tsdown = spawn("pnpm", ["exec", "tsdown"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
const buildExit = await new Promise((resolve) => tsdown.on("exit", resolve));
if (buildExit !== 0) process.exit(buildExit);

// 3. Start tsdown --watch (no wait)
const watch = spawn("pnpm", ["exec", "tsdown", "--watch"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
watch.unref();

// 4. Start server (wait; when it exits, we exit)
const server = spawn("node", ["dist/server.mjs"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "development" },
});
const serverExit = await new Promise((resolve) => server.on("exit", resolve));
process.exit(serverExit ?? 0);
