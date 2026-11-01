/**
 * `tsc --noEmit` with as many checkers as this machine's memory holds.
 *
 * The TypeScript 7 compiler runs four checkers by default, and each holds its
 * own copy of the checked types: the backend needs 9.3 GB that way and 6.0 GB
 * with one. An Agent Runtime pod of a small tier was killed for memory while
 * running it. The count comes from the memory and CPUs the process can count
 * on (`typeScriptCheckers` in vitest.resources.ts). An explicit `--checkers`
 * or `--singleThreaded` wins.
 */
import { spawnSync } from "node:child_process";
import {
  detectResourceEnvelope,
  typeScriptCheckers,
} from "../vitest.resources.ts";

const args = process.argv.slice(2);
const chosen = args.some(
  (arg) =>
    arg === "--checkers" ||
    arg.startsWith("--checkers=") ||
    arg === "--singleThreaded",
);
const checkers = chosen ? null : typeScriptCheckers(detectResourceEnvelope());
const result = spawnSync(
  "tsc",
  checkers === null ? args : [...args, "--checkers", String(checkers)],
  { stdio: "inherit", shell: process.platform === "win32" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
