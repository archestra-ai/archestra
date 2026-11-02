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
import { AGENT_RUNTIME_TOOLCHAIN_PARALLELISM_ENVS } from "@/services/agent-runtime/runtime-contract";
import {
  detectResourceEnvelope,
  typeScriptMemorySettings,
} from "../../../vitest.resources";

// scripts/type-check.ts, run as `pnpm type-check` runs it, against a fake
// tsc that records when each compiler starts and ends.
const PLATFORM_DIR = path.resolve(__dirname, "../../..");
const RUNNER = path.join(PLATFORM_DIR, "scripts/type-check.ts");
const TSX = path.join(PLATFORM_DIR, "backend/node_modules/.bin/tsx");
const hasFlock =
  process.platform === "linux" &&
  spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;

describe("type-check runner", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test.skipIf(!hasFlock)(
    "in a small pod, compilers started together run one at a time with one checker and a capped heap",
    async () => {
      const { log, env } = fakeCompiler();
      // At most 8 GiB: the machine or its container may have less.
      const expected = typeScriptMemorySettings(detectResourceEnvelope(env));
      const runs = Array.from({ length: 3 }, () =>
        runRunner(env, ["--noEmit"]),
      );
      expect(await Promise.all(runs)).toEqual([0, 0, 0]);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      // Each start is followed by its own end before the next start.
      expect(lines).toHaveLength(6);
      for (let i = 0; i < lines.length; i += 2) {
        const [, pid, goMemoryLimit, ...args] = lines[i].split(" ");
        expect(goMemoryLimit).toBe(
          `GOMEMLIMIT=${expected?.goMemoryLimitBytes}`,
        );
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

  test.skipIf(!hasFlock)(
    "keeps the caller's heap limit and build state, whatever the option's case",
    async () => {
      const { log, env } = fakeCompiler();
      env.GOMEMLIMIT = "3GiB";
      for (const args of [
        ["--noEmit", "--Incremental", "true"],
        ["--noEmit", "--tsbuildinfofile", "build.tsbuildinfo"],
      ]) {
        expect(await runRunner(env, args)).toBe(0);
      }
      const starts = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("start "))
        .map((line) => line.split(" ").slice(2).join(" "));
      expect(starts).toEqual([
        "GOMEMLIMIT=3GiB --noEmit --Incremental true --checkers 1",
        "GOMEMLIMIT=3GiB --noEmit --tsbuildinfofile build.tsbuildinfo --checkers 1",
      ]);
    },
    30_000,
  );

  test("turbo hands the runtime's sizing variables to the checks it runs", () => {
    // Turbo drops variables turbo.json does not name: a GOMEMLIMIT or
    // GOMAXPROCS set for the pod would never reach the compiler.
    const turbo = JSON.parse(
      readFileSync(path.join(PLATFORM_DIR, "turbo.json"), "utf8"),
    ) as { globalPassThroughEnv: string[] };
    expect(turbo.globalPassThroughEnv).toEqual(
      expect.arrayContaining([
        "GOMEMLIMIT",
        ...AGENT_RUNTIME_TOOLCHAIN_PARALLELISM_ENVS,
      ]),
    );
  });

  // ===== Helpers =====

  /** A fake tsc on PATH that logs each start and end, and the pod size of tier S. */
  function fakeCompiler(): { log: string; env: NodeJS.ProcessEnv } {
    const scratch = mkdtempSync(path.join(tmpdir(), "type-check-runner-"));
    dir = scratch;
    const log = path.join(scratch, "log");
    writeFileSync(
      path.join(scratch, "tsc"),
      `#!/bin/sh\necho "start $$ GOMEMLIMIT=$GOMEMLIMIT $*" >> "${log}"\nsleep 0.4\necho "end $$" >> "${log}"\n`,
    );
    chmodSync(path.join(scratch, "tsc"), 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${scratch}:${process.env.PATH}`,
      // Its own lock file: the test must not wait for a real type check.
      TMPDIR: scratch,
      ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "2",
      ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT: "8Gi",
    };
    // A limit the shell already sets would win over the runner's.
    delete env.GOMEMLIMIT;
    return { log, env };
  }

  function runRunner(
    env: NodeJS.ProcessEnv,
    args: string[],
  ): Promise<number | null> {
    return new Promise((resolve) =>
      spawn(TSX, [RUNNER, ...args], { env, stdio: "ignore" }).on(
        "exit",
        resolve,
      ),
    );
  }
});
