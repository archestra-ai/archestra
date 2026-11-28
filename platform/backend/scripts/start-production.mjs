#!/usr/bin/env node
// Starts the backend server (dist/server.mjs) with the same Node flags in every
// runtime: Docker and the quickstart, and the Helm chart's web and worker
// pods. Plain Node, so it also runs in the platform image without a shell.
//
// - --report-on-fatalerror and --report-uncaught-exception write a Node
//   diagnostic report on a fatal error or an uncaught exception, into
//   --diagnostic-dir (ARCHESTRA_NODE_DIAGNOSTIC_DIR, or /app/data/diagnostics)
// - --enable-source-maps puts TypeScript files and lines in logged stack
//   traces, only when ARCHESTRA_NODE_SOURCE_MAPS=true asks for it while
//   debugging. Off by default: Node keeps a decoded map of every loaded chunk,
//   about 155 MB of heap on an idle worker. Error reports don't need it; they
//   are symbolicated from the maps uploaded at build time.
// - --max-old-space-size from the container's memory (see maxOldSpaceSizeMib)
// - --heapsnapshot-near-heap-limit only when
//   ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT asks for it
//
// The server replaces this process (process.execve), so it keeps the PID and
// receives the container's signals directly.
//
// Node CLI references: https://nodejs.org/api/cli.html

import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ===
// Public interface
// ===

/**
 * The Node heap limit in MiB to pass as --max-old-space-size, or null to pass
 * none. Throws on an invalid explicit setting.
 *
 * - An operator's own --max-old-space-size in NODE_OPTIONS always wins (null).
 * - ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB sets it; 0 turns it off.
 * - Otherwise 60% of the container's memory limit
 *   (ARCHESTRA_NODE_MEMORY_LIMIT_MIB), keeping 40% for young space, native
 *   memory and thread stacks; without a limit, 75% of its request
 *   (ARCHESTRA_NODE_MEMORY_REQUEST_MIB), Node's documented example ratio.
 * - ARCHESTRA_NODE_MEMORY_RESERVED_MIB is memory other processes in the
 *   container need (the web container also runs the Next.js server), taken
 *   off before the percentage. A reservation that swallows the whole limit is
 *   ignored, since dropping the flag would hand the process Node's default.
 */
export function maxOldSpaceSizeMib(env) {
  if (/(^|\s)--max[-_]old[-_]space[-_]size[=\s]/.test(` ${env.NODE_OPTIONS ?? ""} `)) {
    return null;
  }
  if (env.ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB !== undefined) {
    const override = nonNegativeInteger(env.ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB);
    if (override === null) {
      throw new Error("ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB must be a non-negative integer");
    }
    return override > 0 ? override : null;
  }
  const reserved = nonNegativeInteger(env.ARCHESTRA_NODE_MEMORY_RESERVED_MIB ?? "0");
  if (reserved === null) {
    throw new Error("ARCHESTRA_NODE_MEMORY_RESERVED_MIB must be a non-negative integer");
  }
  return (
    percentage(env.ARCHESTRA_NODE_MEMORY_LIMIT_MIB, 60, reserved) ??
    percentage(env.ARCHESTRA_NODE_MEMORY_REQUEST_MIB, 75, reserved)
  );
}

/**
 * The Node arguments that start the server, and the lines to log about them.
 * Throws on an invalid explicit setting.
 */
export function serverArguments(env) {
  const diagnosticDir = env.ARCHESTRA_NODE_DIAGNOSTIC_DIR || "/app/data/diagnostics";
  const args = [
    "--report-on-fatalerror",
    "--report-uncaught-exception",
    `--diagnostic-dir=${diagnosticDir}`,
  ];
  const messages = [];

  let sourceMaps = false;
  const setting = env.ARCHESTRA_NODE_SOURCE_MAPS;
  if (setting === "true" || setting === "false") {
    sourceMaps = setting === "true";
  } else if (setting !== undefined) {
    messages.push(
      // The value itself is not echoed: environment values stay out of logs.
      "WARNING: ARCHESTRA_NODE_SOURCE_MAPS must be true or false, using false",
    );
  }
  if (sourceMaps) args.unshift("--enable-source-maps");

  const heapMib = maxOldSpaceSizeMib(env);
  if (heapMib !== null) {
    messages.push(`Configuring Node old-space limit: ${heapMib} MiB`);
    args.push(`--max-old-space-size=${heapMib}`);
  }
  if (env.ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT) {
    args.push(`--heapsnapshot-near-heap-limit=${env.ARCHESTRA_NODE_HEAPSNAPSHOT_NEAR_HEAP_LIMIT}`);
  }
  return { args, diagnosticDir, messages };
}

/**
 * Replaces this process with `file` and `args` (process.execve), keeping the
 * PID so the container's signals reach the program itself. Where execve is
 * unavailable, runs it as a child, passes on SIGTERM, SIGINT and SIGHUP, and
 * exits as it does.
 */
export function replaceProcess(file, args, env) {
  if (typeof process.execve === "function") {
    process.execve(file, [file, ...args], env);
  }
  const child = spawn(file, args, { env, stdio: "inherit" });
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(name, () => child.kill(name));
  }
  child.on("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
}

/** Starts the server in place of this process. */
export function main() {
  const env = { ...process.env };
  // An arbitrary UID (OpenShift) has no home directory, so HOME is `/`. The
  // backend's caches live under HOME; give them the image's writable one.
  if (!writable(env.HOME || "/") && writable("/home/archestra")) {
    env.HOME = "/home/archestra";
  }
  let server;
  try {
    server = serverArguments(env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  env.ARCHESTRA_NODE_DIAGNOSTIC_DIR = server.diagnosticDir;
  mkdirSync(server.diagnosticDir, { recursive: true });
  for (const message of server.messages) {
    (message.startsWith("WARNING") ? console.error : console.log)(message);
  }
  const backendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  process.chdir(backendDir);
  replaceProcess(process.execPath, [...server.args, "dist/server.mjs"], env);
}

// ===
// Internal helpers
// ===

function nonNegativeInteger(value) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function percentage(value, percent, reserved) {
  const total = nonNegativeInteger(value ?? "");
  if (total === null) return null;
  const usable = total - reserved > 0 ? total - reserved : total;
  const result = Math.floor((usable * percent) / 100);
  return result > 0 ? result : null;
}

function writable(directory) {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
