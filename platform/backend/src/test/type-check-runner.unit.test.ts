import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

// scripts/type-check.ts, run as `pnpm type-check` runs it, against a fake
// tsc that records when each compiler starts and ends.
const PLATFORM_DIR = path.resolve(__dirname, "../../..");
const RUNNER = path.join(PLATFORM_DIR, "scripts/type-check.ts");
const TSX = path.join(PLATFORM_DIR, "backend/node_modules/.bin/tsx");
const hasFlock =
  process.platform === "linux" &&
  spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;

describe("type-check runner", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test.skipIf(!hasFlock)(
    "in a small pod, compilers started together run one at a time with one checker and a capped heap",
    async () => {
      dir = mkdtempSync(path.join(tmpdir(), "type-check-runner-"));
      const log = path.join(dir, "log");
      writeFileSync(
        path.join(dir, "tsc"),
        `#!/bin/sh\necho "start $$ GOMEMLIMIT=$GOMEMLIMIT $*" >> "${log}"\nsleep 0.4\necho "end $$" >> "${log}"\n`,
      );
      chmodSync(path.join(dir, "tsc"), 0o755);
      const env = {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        // Its own lock file: the test must not wait for a real type check.
        TMPDIR: dir,
        ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "2",
        ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT: "8Gi",
      };
      const runs = Array.from(
        { length: 3 },
        () =>
          new Promise<number | null>((resolve) =>
            spawn(TSX, [RUNNER, "--noEmit"], { env, stdio: "ignore" }).on(
              "exit",
              resolve,
            ),
          ),
      );
      expect(await Promise.all(runs)).toEqual([0, 0, 0]);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      // Each start is followed by its own end before the next start.
      expect(lines).toHaveLength(6);
      for (let i = 0; i < lines.length; i += 2) {
        const [, pid, goMemoryLimit, ...args] = lines[i].split(" ");
        // Five eighths of 8 GiB, and no incremental build state to hold.
        expect(goMemoryLimit).toBe(`GOMEMLIMIT=${5 * 1024 ** 3}`);
        expect(args).toEqual([
          "--noEmit",
          "--checkers",
          "1",
          "--incremental",
          "false",
        ]);
        expect(lines[i + 1]).toBe(`end ${pid}`);
      }
    },
    30_000,
  );
});
