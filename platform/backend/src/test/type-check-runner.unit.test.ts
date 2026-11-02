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

  /** The runner in the fake compiler's directory, which has no tsconfig.json: one program. */
  function runRunner(
    env: NodeJS.ProcessEnv,
    args: string[],
  ): Promise<number | null> {
    return new Promise((resolve) =>
      spawn(TSX, [RUNNER, ...args], {
        env,
        cwd: dir,
        stdio: "ignore",
      }).on("exit", resolve),
    );
  }
});

describe("type-check runner on a solution", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("builds each project in a compiler of its own, references first, sized for a small pod", async () => {
    const { log, env, scratch } = fakeBuildCompiler();
    writeSolution(scratch, {
      // A tsconfig may hold comments and trailing commas.
      "tsconfig.json": `{
        // b and c both reference a.
        "files": [],
        "references": [{ "path": "./b.json" }, { "path": "./c.json" },],
      }`,
      "a.json": "{}",
      "b.json": '{ "references": [{ "path": "./a.json" }] }',
      "c.json": '{ "references": [{ "path": "./a.json" }] }',
    });

    const { status } = await runIn(scratch, env, ["--noEmit"]);

    expect(status).toBe(0);
    expect(starts(log)).toEqual(
      ["a.json", "b.json", "c.json"].map(
        (project) =>
          `GOMEMLIMIT=1342177280 -b ${path.join(scratch, project)} --checkers 1 --builders 1`,
      ),
    );
  }, 30_000);

  test("does not build the projects above a failed one, and builds the others", async () => {
    const { log, env, scratch } = fakeBuildCompiler();
    env.FAKE_TSC_FAIL = "a.json";
    writeSolution(scratch, {
      "tsconfig.json":
        '{ "files": [], "references": [{ "path": "./a.json" }, { "path": "./b.json" }, { "path": "./c.json" }] }',
      "a.json": "{}",
      "b.json": '{ "references": [{ "path": "./a.json" }] }',
      "c.json": "{}",
    });

    const { status, stderr } = await runIn(scratch, env, ["--noEmit"]);

    expect(status).toBe(2);
    expect(
      starts(log).map((line) => path.basename(line.split(" ")[2])),
    ).toEqual(["a.json", "c.json"]);
    expect(stderr).toContain("a.json failed (exit 2)");
    expect(stderr).toContain(
      "not checked, because a project they reference failed: b.json",
    );
  }, 30_000);

  test("refuses project references that form a cycle", async () => {
    const { log, env, scratch } = fakeBuildCompiler();
    writeSolution(scratch, {
      "tsconfig.json":
        '{ "files": [], "references": [{ "path": "./a.json" }] }',
      "a.json": '{ "references": [{ "path": "./b.json" }] }',
      "b.json": '{ "references": [{ "path": "./a.json" }] }',
    });

    const { status, stderr } = await runIn(scratch, env, ["--noEmit"]);

    expect(status).not.toBe(0);
    expect(stderr).toContain("cycle: a.json -> b.json -> a.json");
    expect(starts(log)).toEqual([]);
  }, 30_000);

  // ===== Helpers =====

  /** A fake tsc that logs its starts and fails for the project named in FAKE_TSC_FAIL. */
  function fakeBuildCompiler(): {
    log: string;
    env: NodeJS.ProcessEnv;
    scratch: string;
  } {
    const scratch = mkdtempSync(path.join(tmpdir(), "type-check-solution-"));
    dir = scratch;
    const log = path.join(scratch, "log");
    writeFileSync(log, "");
    writeFileSync(
      path.join(scratch, "tsc"),
      `#!/bin/sh\necho "start GOMEMLIMIT=$GOMEMLIMIT $*" >> "${log}"\ncase "$*" in *"/$FAKE_TSC_FAIL "*) exit 2;; esac\n`,
    );
    chmodSync(path.join(scratch, "tsc"), 0o755);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${scratch}:${process.env.PATH}`,
      TMPDIR: scratch,
      FAKE_TSC_FAIL: "none",
      ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST: "2",
      ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT: "8Gi",
    };
    delete env.GOMEMLIMIT;
    return { log, env, scratch };
  }

  function writeSolution(scratch: string, files: Record<string, string>) {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(path.join(scratch, name), text);
    }
  }

  function starts(log: string): string[] {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("start "))
      .map((line) => line.slice("start ".length));
  }

  function runIn(
    cwd: string,
    env: NodeJS.ProcessEnv,
    args: string[],
  ): Promise<{ status: number | null; stderr: string }> {
    return new Promise((resolve) => {
      let stderr = "";
      const child = spawn(TSX, [RUNNER, ...args], {
        env,
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("exit", (status) => resolve({ status, stderr }));
    });
  }
});
